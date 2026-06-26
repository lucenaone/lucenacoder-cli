import initSqlJs from 'sql.js';
import { createRequire } from 'module';
import { mkdir, readFile, readdir, rename, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { dirname, extname, join, relative, resolve } from 'path';
import { createWorkspaceIgnore } from './ignore-rules.js';
import { parseWorkspaceFile } from './cli-indexer.js';
import { workspaceKitchenSqlitePath } from './lucena-cache.js';
import { buildFileMiseEnPlace } from './lucena-kitchen/fileMiseEnPlace/index.js';
import { buildStyleFileMiseEnPlace, isStylePath } from './lucena-kitchen/styleBlockMiseEnPlace.js';
import { kitchenByteCount, stableKitchenContentHash } from './lucena-kitchen/workspaceKitchenContentHash.js';
import {
  createWorkspaceKitchenDatabase,
  pruneKitchenToManifest,
  removeKitchenPathPrefix,
  upsertFileMiseEnPlace,
} from './lucena-kitchen/workspaceKitchenSqlite.js';

const require = createRequire(import.meta.url);
const sqliteWasmPath = require.resolve('sql.js/dist/sql-wasm.wasm');
const INDEXABLE_EXTENSIONS = new Set([
  '.astro', '.cjs', '.conf', '.config', '.csv', '.css', '.env', '.go', '.graphql',
  '.htm', '.html', '.ini', '.js', '.json', '.jsonc', '.jsx', '.less', '.liquid',
  '.lua', '.md', '.mdx', '.mjs', '.php', '.prisma', '.py', '.rb', '.rs', '.sass',
  '.scss', '.sql', '.svelte', '.toml', '.ts', '.tsx', '.txt', '.vue', '.xml',
  '.yaml', '.yml',
]);
const INDEXABLE_FILENAMES = new Set([
  '.env',
  '.env.example',
  '.gitignore',
  'dockerfile',
  'makefile',
  'package-lock.json',
  'package.json',
  'pnpm-lock.yaml',
  'readme',
  'yarn.lock',
]);

let sqlPromise = null;
let writeQueue = Promise.resolve();

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs({ locateFile: () => sqliteWasmPath });
  }
  return sqlPromise;
}

export async function workspaceKitchenSqliteExists(cwd) {
  return existsSync(await workspaceKitchenSqlitePath(cwd));
}

export async function readWorkspaceKitchenSqliteBytes(cwd) {
  const dbPath = await workspaceKitchenSqlitePath(cwd);
  return existsSync(dbPath) ? await readFile(dbPath) : null;
}

export async function ensureWorkspaceKitchenSqlite(cwd) {
  return withKitchenDb(cwd, async () => undefined, { write: true });
}

export async function indexWorkspaceKitchen(cwd) {
  return withKitchenDb(cwd, async (db) => {
    const files = await collectKitchenFiles(cwd);
    const manifest = [];
    for (const relPath of files) {
      const indexed = await indexKitchenPathIntoDb(db, cwd, relPath);
      if (indexed?.path) manifest.push(indexed.path);
    }
    pruneKitchenToManifest(db, manifest);
    return { indexed: manifest.length, paths: manifest };
  }, { write: true });
}

export async function indexWorkspaceKitchenPath(cwd, requestedPath = '') {
  return withKitchenDb(cwd, async (db) => {
    const relPath = normalizeWorkspacePath(cwd, requestedPath);
    if (!relPath) return { indexed: 0, removed: 0, paths: [] };
    const fullPath = resolve(cwd, relPath.replace(/^\/+/, ''));
    if (!existsSync(fullPath)) {
      const removed = removeKitchenPathPrefix(db, absoluteKitchenPath(cwd, relPath));
      return { indexed: 0, removed: removed.removed || 0, paths: [] };
    }
    const indexed = await indexKitchenPathIntoDb(db, cwd, relPath);
    return {
      indexed: indexed?.path ? 1 : 0,
      removed: 0,
      paths: indexed?.path ? [indexed.path] : [],
    };
  }, { write: true });
}

export async function removeWorkspaceKitchenPath(cwd, requestedPath = '') {
  return withKitchenDb(cwd, async (db) => {
    const relPath = normalizeWorkspacePath(cwd, requestedPath);
    if (!relPath) return { removed: 0, paths: [] };
    const removed = removeKitchenPathPrefix(db, absoluteKitchenPath(cwd, relPath));
    return { removed: removed.removed || 0, paths: removed.paths || [] };
  }, { write: true });
}

async function withKitchenDb(cwd, operation, { write = false } = {}) {
  const run = async () => {
    const SQL = await getSql();
    const dbPath = await workspaceKitchenSqlitePath(cwd);
    const bytes = existsSync(dbPath) ? new Uint8Array(await readFile(dbPath)) : null;
    const db = createWorkspaceKitchenDatabase(SQL, bytes);
    try {
      const result = await operation(db);
      if (write) await saveKitchenDb(dbPath, db);
      return result;
    } finally {
      db.close();
    }
  };
  if (!write) return run();
  const queued = writeQueue.then(run, run);
  writeQueue = queued.catch(() => {});
  return queued;
}

async function saveKitchenDb(dbPath, db) {
  await atomicWriteFile(dbPath, Buffer.from(db.export()));
}

async function atomicWriteFile(filePath, bytes) {
  await mkdir(dirname(filePath), { recursive: true });
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(tempPath, bytes);
  await rename(tempPath, filePath);
}

async function collectKitchenFiles(cwd) {
  const ignore = createWorkspaceIgnore(cwd);
  const files = [];
  await walk(cwd);
  return files.sort();

  async function walk(dirPath) {
    const entries = await readdir(dirPath, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const relPath = relative(cwd, fullPath).replace(/\\/g, '/');
      if (ignore.ignoresPath(relPath)) continue;
      if (entry.isDirectory()) {
        await walk(fullPath);
      } else if (entry.isFile() && isKitchenIndexablePath(entry.name)) {
        files.push(`/${relPath}`);
      }
    }
  }
}

async function indexKitchenPathIntoDb(db, cwd, relPath) {
  const cleanPath = normalizeWorkspacePath(cwd, relPath);
  if (!cleanPath) return null;
  if (!isKitchenIndexablePath(cleanPath)) return null;
  const fullPath = resolve(cwd, cleanPath.replace(/^\/+/, ''));
  if (!existsSync(fullPath)) {
    removeKitchenPathPrefix(db, absoluteKitchenPath(cwd, cleanPath));
    return null;
  }
  const parsed = isStylePath(cleanPath)
    ? { filePath: cleanPath, content: await readFile(fullPath, 'utf-8'), chunks: [] }
    : await parseWorkspaceFile(cwd, cleanPath);
  const content = parsed?.content ?? await readFile(fullPath, 'utf-8');
  if (typeof content !== 'string') return null;

  const path = absoluteKitchenPath(cwd, cleanPath);
  const declarations = (parsed?.chunks || []).map((chunk) => ({
    ...chunk,
    source: chunk.source || chunk.text || '',
  }));
  const mise = isStylePath(path)
    ? buildStyleFileMiseEnPlace({ path, content })
    : buildFileMiseEnPlace({ path, content, declarations });
  const hash = stableKitchenContentHash(content);
  const byteCount = kitchenByteCount(content);
  upsertFileMiseEnPlace(db, {
    mise,
    contentSha256: hash,
    contentFingerprint: `${hash}:${byteCount}`,
    byteCount,
  });
  return { path };
}

function normalizeWorkspacePath(cwd, path = '') {
  const root = resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '');
  const text = String(path || '').replace(/\\/g, '/');
  if (isFilesystemAbsolutePath(text) && text !== root && !text.startsWith(`${root}/`)) return '';
  const relativeText = text === root
    ? ''
    : text.startsWith(`${root}/`)
      ? text.slice(root.length + 1)
      : text.replace(/^\/+/, '');
  const clean = relativeText.replace(/^\/+/, '');
  return clean ? `/${clean}` : '/';
}

function absoluteKitchenPath(cwd, path = '') {
  return `${resolve(cwd).replace(/\\/g, '/').replace(/\/+$/, '')}${normalizeWorkspacePath(cwd, path)}`;
}

function isFilesystemAbsolutePath(path = '') {
  return /^[A-Za-z]:\//u.test(path) || /^\/(?:Users|home|root|var|etc|tmp|private|Volumes)(?:\/|$)/u.test(path);
}

function isKitchenIndexablePath(path = '') {
  const filename = String(path || '').replace(/\\/g, '/').split('/').filter(Boolean).pop()?.toLowerCase() || '';
  return INDEXABLE_FILENAMES.has(filename) || INDEXABLE_EXTENSIONS.has(extname(filename).toLowerCase());
}
