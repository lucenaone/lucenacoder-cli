import { mkdir } from 'fs/promises';
import { realpathSync } from 'fs';
import { homedir } from 'os';
import { basename, join, resolve } from 'path';

export function lucenaCacheRoot() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Caches', 'LucenaCoder');
  }
  if (process.platform === 'win32') {
    return join(process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local'), 'LucenaCoder');
  }
  return join(process.env.XDG_CACHE_HOME || join(homedir(), '.cache'), 'LucenaCoder');
}

export function workspaceCacheKey(cwd = process.cwd()) {
  const root = canonicalWorkspaceRoot(cwd);
  const hash = stableWorkspaceHash(root);
  const safeName = sanitizeWorkspaceName(basename(root) || 'workspace');
  return `${safeName}-${hash}`;
}

export function canonicalWorkspaceRoot(cwd = process.cwd()) {
  const root = resolve(cwd);
  try {
    return realpathSync.native(root);
  } catch {
    return root;
  }
}

export async function workspaceBrainCacheDir(cwd = process.cwd()) {
  const dir = join(lucenaCacheRoot(), 'WorkspaceBrain', workspaceCacheKey(cwd));
  await mkdir(dir, { recursive: true });
  return dir;
}

export async function workspaceBrainSqlitePath(cwd = process.cwd()) {
  return join(await workspaceBrainCacheDir(cwd), 'workspace-history.sqlite');
}

export async function workspaceKitchenSqlitePath(cwd = process.cwd()) {
  return join(await workspaceBrainCacheDir(cwd), 'workspace-kitchen.sqlite');
}

function sanitizeWorkspaceName(name = 'workspace') {
  const clean = String(name || 'workspace')
    .trim()
    .replace(/[^A-Za-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return clean || 'workspace';
}

function stableWorkspaceHash(identity = '') {
  let hash = 0xcbf29ce484222325n;
  const prime = 0x100000001b3n;
  const mask = 0xffffffffffffffffn;
  for (const byte of Buffer.from(String(identity), 'utf8')) {
    hash ^= BigInt(byte);
    hash = (hash * prime) & mask;
  }
  return hash.toString(16).padStart(16, '0');
}
