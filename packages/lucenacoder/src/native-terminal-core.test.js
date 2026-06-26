import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { NativeTerminalCore } from './native-terminal-core.js';

test('finite command exits with code and output', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'lucena-node-terminal-finite-'));
  try {
    await writeFile(path.join(cwd, 'package.json'), '{}');
    const core = new NativeTerminalCore({ cwd });
    const boundary = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('finite command timed out')), 5_000);
      core.on('exit', ({ session, boundary }) => {
        if (session.id !== 'finite') return;
        clearTimeout(timer);
        resolve(boundary);
      });
      core.start({ id: 'finite', command: 'test -f package.json && echo ok', cwd, ownerRunId: 'finite' });
    });
    assert.equal(boundary.status, 'completed');
    assert.equal(boundary.exitCode, 0);
    assert.match(boundary.recentOutput, /ok/);
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test('npm run dev returns a background boundary with detected URL', async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), 'lucena-node-terminal-dev-'));
  try {
    await writeFile(path.join(cwd, 'package.json'), '{"scripts":{"dev":"node server.js"},"dependencies":{}}');
    await writeFile(path.join(cwd, 'server.js'), 'console.log("Local: http://localhost:45680"); setInterval(()=>{},1000);');
    const core = new NativeTerminalCore({ cwd });
    const boundary = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('dev command timed out')), 5_000);
      core.on('boundary', ({ session, boundary }) => {
        if (session.id !== 'dev') return;
        clearTimeout(timer);
        core.stop('dev');
        resolve(boundary);
      });
      core.start({ id: 'dev', command: 'npm run dev', cwd, ownerRunId: 'dev' });
    });
    assert.equal(boundary.status, 'ready_background');
    assert.equal(boundary.reason, 'ready_output_detected');
    assert.equal(boundary.detectedUrls[0], 'http://localhost:45680');
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});
