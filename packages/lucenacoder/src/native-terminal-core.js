import os from 'node:os';
import { EventEmitter } from 'node:events';
import * as pty from 'node-pty';
import {
  createTerminalSession,
  observeTerminalOutput,
  resolveTerminalBoundary,
  terminalDedupeKey,
  terminalSessionSnapshot,
} from './agenticterminal/index.js';

const DEFAULT_COLS = 120;
const DEFAULT_ROWS = 30;

export class NativeTerminalCore extends EventEmitter {
  constructor({ cwd = '', workspaceEnv = {} } = {}) {
    super();
    this.cwd = cwd;
    this.workspaceEnv = workspaceEnv;
    this.sessions = new Map();
    this.backgroundByDedupeKey = new Map();
    this.foregroundByOwner = new Map();
  }

  setWorkspaceEnv(workspaceEnv = {}) {
    this.workspaceEnv = workspaceEnv || {};
  }

  foregroundSession(ownerRunId = '') {
    const sessionId = this.foregroundByOwner.get(ownerRunId);
    const record = sessionId ? this.sessions.get(sessionId) : null;
    return record && isLiveTerminal(record.session) ? record.session : null;
  }

  releaseForeground(sessionId = '') {
    const record = this.sessions.get(sessionId);
    const ownerRunId = record?.session?.ownerRunId || '';
    if (ownerRunId && this.foregroundByOwner.get(ownerRunId) === sessionId) {
      this.foregroundByOwner.delete(ownerRunId);
      return true;
    }
    return false;
  }

  findReusable({ command = '', cwd = this.cwd } = {}) {
    const sessionId = this.backgroundByDedupeKey.get(terminalDedupeKey(command, cwd));
    const record = sessionId ? this.sessions.get(sessionId) : null;
    if (!record || !isLiveTerminal(record.session)) return null;
    return record.session;
  }

  start({
    id,
    command,
    cwd = this.cwd,
    ownerRunId = '',
    threadId = '',
    turnId = '',
    tabScope = '',
    workspaceId = '',
    tunnelId = '',
    runId = '',
    purpose = '',
  } = {}) {
    if (!id) throw new Error('NativeTerminalCore.start requires id.');
    if (!command) throw new Error('NativeTerminalCore.start requires command.');

    const shell = defaultShell();
    const args = shellArgs(command);
    const term = pty.spawn(shell, args, {
      name: 'xterm-256color',
      cols: DEFAULT_COLS,
      rows: DEFAULT_ROWS,
      cwd,
      env: {
        ...process.env,
        ...this.workspaceEnv,
        LUCENA_WORKSPACE_ROOT: cwd,
        TERM: process.env.TERM || 'xterm-256color',
      },
    });

    const session = createTerminalSession({
      id,
      command,
      cwd,
      pid: term.pid,
      ownerRunId,
      threadId,
      turnId,
      tabScope,
      workspaceId,
      tunnelId,
      runId,
      purpose,
    });
    session.child = term;

    const record = { session, term, exitBoundary: null };
    this.sessions.set(id, record);
    if (ownerRunId) this.foregroundByOwner.set(ownerRunId, id);
    if (session.longRunning) this.backgroundByDedupeKey.set(session.dedupeKey, id);

    term.onData((data) => {
      observeTerminalOutput(session, data, { stream: 'stdout' });
      this.emit('data', { session, chunk: data, stream: 'stdout' });
      const boundary = resolveTerminalBoundary(session);
      if (boundary) this.emit('boundary', { session, boundary });
    });

    term.onExit(({ exitCode, signal }) => {
      session.exitCode = typeof exitCode === 'number' ? exitCode : 0;
      session.signal = signal || null;
      session.status = session.exitCode === 0 ? 'completed' : 'failed';
      record.exitBoundary = resolveTerminalBoundary(session, {
        closed: true,
        exitCode: session.exitCode,
        signal: session.signal,
      }) || terminalSessionSnapshot(session, {
        reason: 'process_exited_after_receipt',
        status: session.status,
      });
      this.emit('exit', { session, boundary: record.exitBoundary });
    });

    return session;
  }

  write(sessionId = '', input = '') {
    const record = this.sessions.get(sessionId);
    if (!record || !isLiveTerminal(record.session)) throw new Error('Terminal session was not found.');
    record.term.write(String(input || ''));
    record.session.status = 'running';
    record.session.inputPrompt = '';
    record.session.updatedAt = Date.now();
    return terminalSessionSnapshot(record.session, { reason: 'terminal_input_sent' });
  }

  stop(sessionId = '') {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    try { record.term.kill(); } catch { /* already gone */ }
    record.session.status = 'stopped';
    const boundary = terminalSessionSnapshot(record.session, { reason: 'terminal_session_stopped', status: 'stopped' });
    this.remove(sessionId);
    return boundary;
  }

  read(sessionId = '') {
    const record = this.sessions.get(sessionId);
    if (!record) return null;
    if (record.exitBoundary) {
      const boundary = record.exitBoundary;
      this.remove(sessionId);
      return boundary;
    }
    const boundary = resolveTerminalBoundary(record.session, { force: true })
      || terminalSessionSnapshot(record.session, { reason: 'terminal_session_read' });
    if (['completed', 'failed', 'stopped'].includes(boundary.status)) this.remove(sessionId);
    return boundary;
  }

  snapshot(sessionId = '', { reason = 'terminal_session_snapshot' } = {}) {
    const record = this.sessions.get(sessionId);
    return record ? terminalSessionSnapshot(record.session, { reason }) : null;
  }

  remove(sessionId = '') {
    const record = this.sessions.get(sessionId);
    if (!record) return false;
    this.sessions.delete(sessionId);
    const session = record.session;
    if (session.ownerRunId && this.foregroundByOwner.get(session.ownerRunId) === sessionId) {
      this.foregroundByOwner.delete(session.ownerRunId);
    }
    if (session.dedupeKey && this.backgroundByDedupeKey.get(session.dedupeKey) === sessionId) {
      this.backgroundByDedupeKey.delete(session.dedupeKey);
    }
    return true;
  }

  stopAll() {
    for (const sessionId of [...this.sessions.keys()]) this.stop(sessionId);
  }
}

function defaultShell() {
  if (process.platform === 'win32') return process.env.ComSpec || 'powershell.exe';
  return process.env.SHELL || (os.platform() === 'darwin' ? '/bin/zsh' : '/bin/bash');
}

function shellArgs(command = '') {
  if (process.platform === 'win32') return ['/C', command];
  return ['-ilc', command];
}

function isLiveTerminal(session = null) {
  return Boolean(session && !['completed', 'failed', 'stopped'].includes(session.status));
}
