import ignore from 'ignore';
import { existsSync, readFileSync } from 'fs';
import { basename, isAbsolute, join, relative } from 'path';

const INTERNAL_IGNORES = [
  '.git/',
  '.WorkspaceBrain/',
  '.lucena/',
  '.firebase/',
  '.next/',
  '.wrangler/',
  '.cache/',
  '.turbo/',
  '.vercel/',
  '.venv/',
  'venv/',
  '__pycache__/',
  '.pytest_cache/',
  '.mypy_cache/',
  'node_modules/',
  'dist/',
  'build/',
  'coverage/',
  'target/',
  'out/',
  '.gradle/',
  '.DS_Store',
];

export function createWorkspaceIgnore(cwd) {
  const matcher = ignore();
  matcher.add(INTERNAL_IGNORES);

  const gitignorePath = join(cwd, '.gitignore');
  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, 'utf-8');
    matcher.add(gitignore);
  }

  return {
    ignoresPath(pathValue) {
      const relPath = normalizeRelativePath(cwd, pathValue);
      if (!relPath) return false;
      if (basename(relPath) === '.DS_Store') return true;
      if (isWorkspaceBrainSkillsPath(relPath)) return false;
      if (isPrivateWorkspaceBrainPath(relPath)) return true;
      return matcher.ignores(relPath) || matcher.ignores(`${relPath}/`) || matcher.ignores(basename(relPath));
    },
  };
}

function isWorkspaceBrainSkillsPath(relPath = '') {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized === '.WorkspaceBrain'
    || normalized === '.WorkspaceBrain/skills'
    || normalized.startsWith('.WorkspaceBrain/skills/');
}

function isPrivateWorkspaceBrainPath(relPath = '') {
  const normalized = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return normalized.startsWith('.WorkspaceBrain/')
    && normalized !== '.WorkspaceBrain/skills'
    && !normalized.startsWith('.WorkspaceBrain/skills/');
}

function normalizeRelativePath(cwd, pathValue) {
  const raw = String(pathValue || '').replace(/\\/g, '/');
  const rel = isAbsolute(raw) ? relative(cwd, raw) : raw;
  const normalized = rel.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized === '.') return '';
  if (normalized.startsWith('../') || normalized === '..') return normalized;
  return normalized;
}
