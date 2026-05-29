import { initializeApp } from 'firebase/app';
import { getDatabase, ref, push, set, update, onChildAdded, onDisconnect, serverTimestamp, remove, get } from 'firebase/database';
import { spawn, spawnSync } from 'child_process';
import { watch } from 'chokidar';
import { readFile, writeFile, mkdir, readdir, stat, unlink, rm } from 'fs/promises';
import { join, resolve, dirname, basename, relative, isAbsolute, extname } from 'path';
import { existsSync, mkdirSync } from 'fs';
import { FIREBASE_CONFIG } from './config.js';
import { buildIndex, reindexFile } from './cli-indexer.js';
import { LucenaShell } from './lucena-shell.js';
import { storeProToken } from './pro-token.js';
import { createWorkspaceIgnore } from './ignore-rules.js';
import {
  ensureWorkspaceBrainSqlite,
  getWorkspaceBrainThread,
  loadWorkspaceBrainState,
  saveWorkspaceBrainState,
  upsertWorkspaceBrainThread,
} from './workspace-brain-sqlite.js';

const SEARCH_GLOB = '*.{js,jsx,ts,tsx,json,md,css,html,py,rb,go,rs,dart}';
const SEARCH_EXCLUDE_GLOBS = [
  '!**/.git/**',
  '!**/node_modules/**',
  '!**/dist/**',
  '!**/build/**',
  '!**/coverage/**',
  '!**/.DS_Store',
  '!**/.WorkspaceBrain/workspace.*',
  '!**/.WorkspaceBrain/threads/**',
  '!**/.WorkspaceBrain/memories/**',
  '!**/.WorkspaceBrain/context/**',
];
const SEARCH_SKILLS_GLOB = '.WorkspaceBrain/skills/**';
const TUNNEL_HEARTBEAT_INTERVAL_MS = 15_000;
const REMOTE_STATUS_INTERVAL_MS = 15_000;

// ── The CLI Jailer ──
function getJailedPath(baseDir, rawPath) {
  let p = rawPath.replace(/\\/g, '/');
  
  // If the AI hallucinates the absolute path of the workspace, dynamically strip it out
  const normalizedBase = baseDir.replace(/\\/g, '/');
  if (p.startsWith(normalizedBase)) {
    p = p.slice(normalizedBase.length);
  }
  
  // Strip leading slashes to force relative resolution
  p = p.replace(/^\/+/, '');
  
  const parts = p.split('/').filter(part => part !== '.' && part !== '');
  const safeParts = [];
  
  for (const part of parts) {
    if (part === '..') safeParts.pop(); // Traversal clamping
    else safeParts.push(part);
  }
  
  return resolve(baseDir, safeParts.join('/'));
}

// ── Path Sanitizer ──
// Strips the absolute cwd from any text output so the AI never sees
// real filesystem paths. Replaces /Users/whoever/projects/foo with /
function stripCwd(cwd, text) {
  if (!text || typeof text !== 'string') return text;
  // Normalize both to forward-slash form for reliable matching
  const normalized = cwd.replace(/\\/g, '/');
  // Escape regex special chars in the path
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Replace the absolute path (with or without trailing slash) with just /
  return text.replace(new RegExp(escaped + '/?', 'g'), '/');
}

export class LucenaAgent {
  constructor(cwd, options = {}) {
    this.cwd = resolve(cwd);
    this.proToken = options.proToken || null;
    this.tunnelId = crypto.randomUUID();
    this.app = null;
    this.db = null;
    this.watcher = null;
    this.activeCommands = new Map();
    this.connected = false;
    this.stripCwd = true; // Default: strip absolute paths (Browser Mode safety)
    this.indexData = null; // Pre-built index from CLI-side parsing
    this.indexPromise = null; // The in-flight indexing promise
    this.browserConnected = false;
    this.remoteStatusTimer = null;
    this.heartbeatTimer = null;
    this.commandClients = new Map();
    this.remoteControlRegistrationNotice = '';
    this.shell = new LucenaShell(this.cwd);
    this.ignore = createWorkspaceIgnore(this.cwd);
  }

  /** Conditionally strip cwd — only in Browser Mode */
  _sanitize(text) {
    return this.stripCwd ? stripCwd(this.cwd, text) : text;
  }

  _isIgnoredPath(fullPath) {
    return this.ignore.ignoresPath(relative(this.cwd, fullPath));
  }

  _scaffoldWorkspaceBrain() {
    const brainDir = join(this.cwd, '.WorkspaceBrain');
    const subdirs = ['skills'];
    try {
      if (!existsSync(brainDir)) mkdirSync(brainDir, { recursive: true });
      for (const sub of subdirs) {
        const subPath = join(brainDir, sub);
        if (!existsSync(subPath)) mkdirSync(subPath, { recursive: true });
      }
    } catch (err) {
      // Non-fatal — the brain is best-effort
      console.warn('[workspace-brain] scaffold failed:', err.message);
    }
  }

  async start() {
    // Ensure .WorkspaceBrain/ exists on disk with subdirectories
    this._scaffoldWorkspaceBrain();
    await ensureWorkspaceBrainSqlite(this.cwd).catch((err) => {
      console.warn('[workspace-brain] sqlite init failed:', err.message);
    });

    // The tunnel URL must not become live until the CLI has the startup
    // artifact the browser needs: file tree + AST symbol index.
    this.indexPromise = buildIndex(this.cwd, (progress) => {
      if (progress.phase === 'parsing' && progress.current > 0) {
        process.stdout.write(`\r  ${'\x1b[90m'}⏳ Indexing... ${progress.current}/${progress.total} files${'\x1b[0m'}`);
      }
    });
    this.indexData = await this.indexPromise;
    const { stats } = this.indexData;
    process.stdout.write(`\r  ${'\x1b[32m'}✔ Indexed ${stats.filesParsed} files — ${stats.symbolCount} symbols across ${stats.fileCount} files${'\x1b[0m'}  \n`);

    this.app = initializeApp(FIREBASE_CONFIG, `agent-${this.tunnelId}`);
    this.db = getDatabase(this.app);
    const tunnelRef = ref(this.db, `tunnels/${this.tunnelId}`);

    await set(tunnelRef, {
      meta: {
        createdAt: serverTimestamp(),
        lastHeartbeatAt: Date.now(),
        cwdName: basename(this.cwd),  // Never expose full cwd to the browser
        status: 'active',
        online: true,
        pid: process.pid,
        platform: process.platform
      }
    });

    onChildAdded(ref(this.db, `.info`), () => {});
    onDisconnect(tunnelRef).remove();
    await this.publishStartupSnapshot();

    this.heartbeatTimer = setInterval(() => {
      update(ref(this.db, `tunnels/${this.tunnelId}/meta`), {
        lastHeartbeatAt: Date.now(),
        cwdName: basename(this.cwd),
        status: 'active',
        online: true,
        pid: process.pid,
        platform: process.platform
      }).catch(() => {});
    }, TUNNEL_HEARTBEAT_INTERVAL_MS);

    // ── Listen for browser connect events ──
    // Browser connect is presence/session metadata. The startup snapshot is
    // already published before the tunnel URL is returned.
    onChildAdded(ref(this.db, `tunnels/${this.tunnelId}/browserConnect`), async (snapshot) => {
      const data = snapshot.val();
      if (!data) return;
      remove(snapshot.ref);
      this.browserConnected = true;
      
      // Browser tells us whether to strip cwd from output
      if (typeof data.stripCwd === 'boolean') {
        this.stripCwd = data.stripCwd;
      }

      if (data.proToken) {
        await storeProToken({ tokenForPro: data.proToken, email: data.proEmail });
        console.log(`  ${'\x1b[36m'}PRO token stored. Future runs can auto-launch.${'\x1b[0m'}`);
        if (this.remoteControlRegistrationNotice) {
          console.log(this.remoteControlRegistrationNotice);
          this.remoteControlRegistrationNotice = '';
        }
      }
    });

    const commandsRef = ref(this.db, `tunnels/${this.tunnelId}/commands`);
    onChildAdded(commandsRef, async (snapshot) => {
      const command = snapshot.val();
      if (!command) return;
      remove(snapshot.ref);
      if (command.messageId) {
        this.commandClients.set(command.messageId, command.clientId || null);
      }

      try {
        await this.handleCommand(command);
      } catch (err) {
        this.pushResponse(command.messageId, 'error', this._sanitize(err.message));
      }
    });

    if (this.proToken) this.startRemoteControlPresence();

    this.startWatcher();
    this.connected = true;

    return this.tunnelId;
  }

  setRemoteControlRegistrationNotice(message) {
    this.remoteControlRegistrationNotice = message || '';
  }

  // ── Publish the startup artifact before exposing the tunnel URL ──
  async publishStartupSnapshot() {
    const snapshotRef = ref(this.db, `tunnels/${this.tunnelId}/indexSnapshot`);
    await set(snapshotRef, {
      files: this.indexData.files,
      symbols: this.indexData.symbols,
      stats: this.indexData.stats,
      timestamp: serverTimestamp(),
    });
    console.log(`  ${'\x1b[36m'}📡 Index snapshot pushed to browser${'\x1b[0m'}`);
  }

  // ── Push an incremental delta when a file changes ──
  async pushIndexDelta(relPath) {
    if (this.ignore.ignoresPath(relPath)) return;

    const ext = extname(relPath);
    const SUPPORTED_EXTS = ['.js', '.jsx', '.ts', '.tsx', '.py', '.rb', '.go', '.rs'];
    if (!SUPPORTED_EXTS.includes(ext)) return;

    const delta = await reindexFile(this.cwd, '/' + relPath);
    if (!delta) return;

    const deltaRef = ref(this.db, `tunnels/${this.tunnelId}/indexDeltas`);
    push(deltaRef, {
      filePath: delta.filePath,
      symbols: delta.symbols,
      timestamp: serverTimestamp(),
    });
  }

  async handleCommand(command) {
    const { type, messageId } = command;
    switch (type) {
      case 'execute': return this.executeCommand(command);
      case 'read_files': return this.readFileCmd(command);
      case 'file_put': return this.putFileCmd(command);
      case 'workspace_brain_read': return this.workspaceBrainReadCmd(command);
      case 'workspace_brain_write': return this.workspaceBrainWriteCmd(command);
      case 'workspace_brain_load_state': return this.workspaceBrainLoadStateCmd(command);
      case 'workspace_brain_save_state': return this.workspaceBrainSaveStateCmd(command);
      case 'workspace_brain_get_thread': return this.workspaceBrainGetThreadCmd(command);
      case 'workspace_brain_upsert_thread': return this.workspaceBrainUpsertThreadCmd(command);
      case 'list_files': return this.listFiles(command);
      case 'list_directories': return this.listDir(command);
      case 'stat': return this.statFile(command);
      case 'delete_file': return this.deleteFile(command);
      case 'mkdir': return this.mkdirCmd(command);
      case 'search': return this.searchCodebase(command);
      case 'store_pro_token': return this.storeProTokenCmd(command);
      case 'ping': return this.pushResponse(messageId, 'pong', '');
      default: return this.pushResponse(messageId, 'error', `Unknown command type: ${type}`);
    }
  }

  startRemoteControlPresence() {
    if (!this.db || this.remoteStatusTimer) return;
    const statusRef = ref(this.db, `tunnels/${this.tunnelId}/remoteControl/desktop/status`);
    const publishStatus = () => set(statusRef, {
      online: true,
      linkStatus: 'local',
      platform: process.platform,
      projectName: basename(this.cwd),
      syncStatus: 'ready',
      chatStatus: 'idle',
      workerStatus: 'online',
      updatedAt: Date.now(),
    }).catch(() => {});
    publishStatus();
    this.remoteStatusTimer = setInterval(publishStatus, REMOTE_STATUS_INTERVAL_MS);
    onDisconnect(statusRef).set({
      online: false,
      linkStatus: 'local',
      platform: process.platform,
      projectName: basename(this.cwd),
      workerStatus: 'offline',
      updatedAt: Date.now(),
    });
  }

  async storeProTokenCmd({ messageId, tokenForPro, email }) {
    if (!tokenForPro) return this.pushResponse(messageId, 'error', 'tokenForPro is required');
    await storeProToken({ tokenForPro, email });
    this.pushResponse(messageId, 'done', 'PRO token stored');
  }

  pushResponse(messageId, type, text, extra = {}) {
    const responsesRef = ref(this.db, `tunnels/${this.tunnelId}/responses`);
    const clientId = this.commandClients.get(messageId) || null;
    const responseRef = push(responsesRef);
    set(responseRef, {
      messageId,
      clientId,
      type,
      text,
      timestamp: serverTimestamp(),
      ...extra
    }).finally(() => {
      if (['done', 'error', 'pong'].includes(type)) this.commandClients.delete(messageId);
    });
  }

  async executeCommand({ messageId, command, mode = 'safe', approved = false, outsideWorkspaceApproved = false }) {
    let child;

    try {
      child = this.shell.execute(command, { mode, approved, outsideWorkspaceApproved });
    } catch (err) {
      return this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }

    child.stdout?.on('data', (data) => {
      this.pushResponse(messageId, 'output', this._sanitize(data.toString()));
    });
    child.stderr?.on('data', (data) => {
      this.pushResponse(messageId, 'output', this._sanitize(data.toString()));
    });

    // Immediately close stdin so commands that try to read it get EOF
    // instead of hanging until the 60s timeout
    try { child.stdin?.end(); } catch { /* already closed */ }

    child.on('close', (code) => {
      this.pushResponse(messageId, 'done', '', { exitCode: code ?? 0 });
      this.activeCommands.delete(messageId);
    });

    this.activeCommands.set(messageId, child);
  }

  async readFileCmd({ messageId, path: filePath }) {
    const fullPath = getJailedPath(this.cwd, filePath);
    if (this._isIgnoredPath(fullPath)) {
      return this.pushResponse(messageId, 'error', 'Path is not available in this workspace');
    }
    try {
      const content = await readFile(fullPath, 'utf-8');
      this.pushResponse(messageId, 'output', content);
      this.pushResponse(messageId, 'done', '');
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async putFileCmd({ messageId, path: filePath, content, source }) {
    const fullPath = getJailedPath(this.cwd, filePath);
    if (this._isIgnoredPath(fullPath)) {
      return this.pushResponse(messageId, 'error', 'Path is not available in this workspace');
    }
    const relPath = toBrowserPath(relative(this.cwd, fullPath));
    try {
      let existed = true;
      let originalContent = '';
      try {
        originalContent = await readFile(fullPath, 'utf-8');
      } catch {
        existed = false;
      }
      await mkdir(dirname(fullPath), { recursive: true });
      const nextContent = String(content ?? '');
      await writeFile(fullPath, nextContent, 'utf-8');
      if (source) {
        const changesRef = ref(this.db, `tunnels/${this.tunnelId}/fileChanges`);
        push(changesRef, {
          event: existed ? 'change' : 'add',
          path: relPath,
          source,
          originalContent,
          content: nextContent,
          timestamp: serverTimestamp()
        }).catch(() => {});
      }
      this.pushResponse(messageId, 'done', `Wrote ${relPath}`);
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async workspaceBrainReadCmd({ messageId, path: filePath }) {
    const normalized = this._normalizeWorkspaceBrainPath(filePath);
    if (!normalized) return this.pushResponse(messageId, 'error', 'WorkspaceBrain path is required');
    const fullPath = getJailedPath(this.cwd, normalized);
    try {
      const content = await readFile(fullPath, 'utf-8');
      this.pushResponse(messageId, 'output', content);
      this.pushResponse(messageId, 'done', '');
    } catch (err) {
      if (err?.code === 'ENOENT') return this.pushResponse(messageId, 'done', '');
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async workspaceBrainWriteCmd({ messageId, path: filePath, content }) {
    const normalized = this._normalizeWorkspaceBrainPath(filePath);
    if (!normalized) return this.pushResponse(messageId, 'error', 'WorkspaceBrain path is required');
    const fullPath = getJailedPath(this.cwd, normalized);
    try {
      await mkdir(dirname(fullPath), { recursive: true });
      await writeFile(fullPath, String(content ?? ''), 'utf-8');
      this.pushResponse(messageId, 'done', `Wrote ${normalized}`);
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async workspaceBrainLoadStateCmd({ messageId }) {
    try {
      this.pushResponse(messageId, 'output', JSON.stringify(await loadWorkspaceBrainState(this.cwd)));
      this.pushResponse(messageId, 'done', '');
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async workspaceBrainSaveStateCmd({ messageId, threads = [], tabThreadMap = {}, project = null }) {
    try {
      await saveWorkspaceBrainState(this.cwd, { threads, tabThreadMap, project });
      this.pushResponse(messageId, 'done', 'WorkspaceBrain SQLite state saved');
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async workspaceBrainGetThreadCmd({ messageId, threadId = '' }) {
    try {
      this.pushResponse(messageId, 'output', JSON.stringify(await getWorkspaceBrainThread(this.cwd, threadId)));
      this.pushResponse(messageId, 'done', '');
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async workspaceBrainUpsertThreadCmd({ messageId, thread }) {
    try {
      await upsertWorkspaceBrainThread(this.cwd, thread);
      this.pushResponse(messageId, 'done', 'WorkspaceBrain SQLite thread saved');
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  _normalizeWorkspaceBrainPath(filePath) {
    const normalized = String(filePath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!normalized.startsWith('.WorkspaceBrain/')) return '';
    if (normalized.split('/').includes('..')) return '';
    return `/${normalized}`;
  }

  async listDir({ messageId, path: dirPath }) {
    const fullPath = getJailedPath(this.cwd, dirPath || '.');
    if (this._isIgnoredPath(fullPath)) {
      return this.pushResponse(messageId, 'done', '(empty)');
    }
    try {
      const entries = await readdir(fullPath, { withFileTypes: true });
      const listing = entries
        .filter(e => !this.ignore.ignoresPath(relative(this.cwd, join(fullPath, e.name))))
        .map(e => `${e.isDirectory() ? 'dir' : 'file'}: ${e.name}`)
        .join('\n');
      this.pushResponse(messageId, 'done', listing || '(empty)');
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async listFiles({ messageId }) {
    try {
      const files = await this.walkFiles(this.cwd);
      this.pushResponse(messageId, 'done', JSON.stringify(files));
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async walkFiles(dirPath, relativeDir = '') {
    const entries = await readdir(dirPath, { withFileTypes: true });
    const files = [];

    for (const entry of entries) {
      const relPath = relativeDir ? `${relativeDir}/${entry.name}` : entry.name;
      if (this.ignore.ignoresPath(relPath)) continue;
      const fullPath = join(dirPath, entry.name);

      if (entry.isDirectory()) {
        files.push(...await this.walkFiles(fullPath, relPath));
      } else if (entry.isFile()) {
        files.push({
          path: relPath,
          lineCount: await countTextFileLines(fullPath),
        });
      }
    }

    return files;
  }

  async statFile({ messageId, path: filePath }) {
    const fullPath = getJailedPath(this.cwd, filePath);
    if (this._isIgnoredPath(fullPath)) {
      return this.pushResponse(messageId, 'error', 'Path is not available in this workspace');
    }
    try {
      const s = await stat(fullPath);
      this.pushResponse(messageId, 'done', JSON.stringify({
        size: s.size,
        isFile: s.isFile(),
        isDir: s.isDirectory(),
        modified: s.mtime,
        created: s.birthtime
      }));
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async deleteFile({ messageId, path: filePath }) {
    const fullPath = getJailedPath(this.cwd, filePath);
    if (this._isIgnoredPath(fullPath)) {
      return this.pushResponse(messageId, 'error', 'Path is not available in this workspace');
    }
    const relPath = toBrowserPath(relative(this.cwd, fullPath));
    try {
      if ((await stat(fullPath)).isDirectory()) {
        await rm(fullPath, { recursive: true });
      } else {
        await unlink(fullPath);
      }
      this.pushResponse(messageId, 'done', `Deleted ${relPath}`);
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async mkdirCmd({ messageId, path: dirPath }) {
    const fullPath = getJailedPath(this.cwd, dirPath);
    if (this._isIgnoredPath(fullPath)) {
      return this.pushResponse(messageId, 'error', 'Path is not available in this workspace');
    }
    const relPath = toBrowserPath(relative(this.cwd, fullPath));
    try {
      await mkdir(fullPath, { recursive: true });
      this.pushResponse(messageId, 'done', `Created ${relPath}`);
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  async searchCodebase({ messageId, query, directory }) {
    const searchDir = getJailedPath(this.cwd, directory || '.');
    if (this.ignore.ignoresPath(relative(this.cwd, searchDir))) {
      return this.pushResponse(messageId, 'done', 'No matches found');
    }
    try {
      const child = this._createSearchProcess(query, searchDir);

      let output = '';
      child.stdout.on('data', (d) => { output += d.toString(); });
      child.stderr.on('data', (d) => { output += d.toString(); });

      child.on('close', (code) => {
        this.pushResponse(messageId, 'done', this._sanitize(output) || 'No matches found');
      });
      child.on('error', (err) => {
        this.pushResponse(messageId, 'error', this._sanitize(err.message));
      });
    } catch (err) {
      this.pushResponse(messageId, 'error', this._sanitize(err.message));
    }
  }

  _createSearchProcess(query, searchDir) {
    try {
      const rg = spawnSync('rg', ['--version'], { cwd: this.cwd, encoding: 'utf8' });
      if (rg.status === 0) {
        return spawn('rg', [
          '-n',
          '--hidden',
          '--no-ignore',
          '--glob', SEARCH_GLOB,
          ...SEARCH_EXCLUDE_GLOBS.flatMap((glob) => ['--glob', glob]),
          '--glob', SEARCH_SKILLS_GLOB,
          query,
          searchDir,
        ], { cwd: this.cwd });
      }
    } catch {
      // Fall back to the OS-native search tool below.
    }

    if (process.platform === 'win32') {
      return spawn('findstr', ['/s', '/n', `/c:${query}`, join(searchDir, '*')], {
        cwd: this.cwd,
        shell: true,
      });
    }

    return spawn('grep', [
      '-rn', `--include=${SEARCH_GLOB}`,
      query, searchDir
    ], { cwd: this.cwd });
  }

  startWatcher() {
    this.watcher = watch(this.cwd, {
      ignored: (path) => this.ignore.ignoresPath(path),
      persistent: true,
      ignoreInitial: true
    });

    this.watcher.on('all', (event, filePath) => {
      const relPath = relative(this.cwd, filePath);
      const normalizedRelPath = relPath.replace(/\\/g, '/');
      
      // Stop anything escaping local disk
      if (!normalizedRelPath || normalizedRelPath.startsWith('..') || isAbsolute(relPath)) {
        return; 
      }

      const changesRef = ref(this.db, `tunnels/${this.tunnelId}/fileChanges`);
      push(changesRef, {
        event,
        path: normalizedRelPath,
        timestamp: serverTimestamp()
      });

      // ── Push incremental index delta for changed files ──
      if (event === 'change' || event === 'add') {
        this.pushIndexDelta(normalizedRelPath).catch(() => {}); // Non-blocking, non-fatal
      }
    });
  }

  async shutdown() {
    for (const [messageId, child] of this.activeCommands) {
      child.kill('SIGTERM');
      this.pushResponse(messageId, 'error', 'Command killed: tunnel shutting down');
    }
    this.activeCommands.clear();

    if (this.watcher) await this.watcher.close();
    if (this.db) {
      if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
      if (this.remoteStatusTimer) clearInterval(this.remoteStatusTimer);
      await remove(ref(this.db, `tunnels/${this.tunnelId}`));
    }

    this.connected = false;
  }
}

function toBrowserPath(pathValue) {
  return '/' + String(pathValue || '').replace(/\\/g, '/');
}

async function countTextFileLines(fullPath) {
  if (!isTextLikeFile(fullPath)) return null;

  try {
    const info = await stat(fullPath);
    if (info.size > 5 * 1024 * 1024) return null;
    const content = await readFile(fullPath, 'utf-8');
    if (!content) return 0;
    return content.split('\n').length;
  } catch {
    return null;
  }
}

function isTextLikeFile(filePath) {
  return /\.(cjs|css|csv|go|html?|js|jsx|json|mdx?|mjs|py|rb|rs|sql|svg|ts|tsx|txt|xml|ya?ml)$/i.test(filePath);
}
