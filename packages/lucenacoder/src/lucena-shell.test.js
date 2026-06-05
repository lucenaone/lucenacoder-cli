import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { LucenaShell } from './lucena-shell.js';
import { isLikelyLongRunningServerCommand } from './agent.js';

test('workspace-absolute command paths stay inside the workspace in yolo mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'lucena-shell-'));
  const shell = new LucenaShell(root);
  const decision = shell.canExecute('mv /index.html /deprecated_index.html', { mode: 'yolo' });

  assert.equal(decision.ok, true);
  assert.equal(decision.analysis.touchesOutsideWorkspace, false);
});

test('workspace-absolute command paths execute against the workspace root', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lucena-shell-'));
  writeFileSync(join(root, 'index.html'), '<h1>Home</h1>');
  const shell = new LucenaShell(root);

  const result = await shell.execute('mv /index.html /deprecated_index.html', { mode: 'yolo' });

  assert.equal(result.exitCode, 0);
  assert.equal(existsSync(join(root, 'index.html')), false);
  assert.equal(existsSync(join(root, 'deprecated_index.html')), true);
});

test('workspace path normalization preserves shell redirection and globs', () => {
  const root = mkdtempSync(join(tmpdir(), 'lucena-shell-'));
  const shell = new LucenaShell(root);
  const analysis = shell.analyze('ls -la *.html 2>&1; cd /privatebeta_frontend && npm run build 2>&1');

  assert.match(analysis.command, /\*\.html 2>&1/u);
  assert.match(analysis.command, /npm run build 2>&1/u);
  assert.doesNotMatch(analysis.command, /\bglob\b/u);
  assert.doesNotMatch(analysis.command, /2\s+>&\s+1/u);
  assert.match(analysis.command, new RegExp(`${root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/privatebeta_frontend`, 'u'));
});

test('real machine absolute paths remain outside-workspace mutations in yolo mode', () => {
  const root = mkdtempSync(join(tmpdir(), 'lucena-shell-'));
  const shell = new LucenaShell(root);
  const decision = shell.canExecute('mv /index.html /tmp/deprecated_index.html', { mode: 'yolo' });

  assert.equal(decision.ok, false);
  assert.equal(decision.analysis.touchesOutsideWorkspace, true);
  assert.match(decision.reason, /outside-workspace mutation/i);
});

test('dev server commands are classified as long-running servers', () => {
  assert.equal(isLikelyLongRunningServerCommand('cd privatebeta_frontend && npm run dev'), true);
  assert.equal(isLikelyLongRunningServerCommand('pnpm dev --host 0.0.0.0'), true);
  assert.equal(isLikelyLongRunningServerCommand('npx vite --host 0.0.0.0'), true);
  assert.equal(isLikelyLongRunningServerCommand('next dev'), true);
  assert.equal(isLikelyLongRunningServerCommand('npm run build'), false);
  assert.equal(isLikelyLongRunningServerCommand('npm install'), false);
});
