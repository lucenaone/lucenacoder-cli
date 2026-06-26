import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { LucenaAgent } from './agent.js';

function createTestAgent(root) {
  const agent = new LucenaAgent(root);
  agent.stripCwd = false;
  const responses = [];
  agent.pushResponse = async (messageId, type, text) => {
    responses.push({ messageId, type, text });
  };
  return { agent, responses };
}

test('CLI file commands accept host absolute paths inside the workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lucena-agent-absolute-'));
  const { agent, responses } = createTestAgent(root);
  const path = `${root}/src/App.jsx`;

  await agent.putFileCmd({ messageId: 'write', path, content: 'export default 1;\n' });
  await agent.readFileCmd({ messageId: 'read', path });

  assert.deepEqual(responses, [
    { messageId: 'write', type: 'done', text: `Wrote ${path}` },
    { messageId: 'read', type: 'output', text: 'export default 1;\n' },
    { messageId: 'read', type: 'done', text: '' },
  ]);
});

test('CLI file commands reject outside host absolute paths instead of remapping them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lucena-agent-outside-'));
  const { agent } = createTestAgent(root);

  await assert.rejects(
    () => agent.putFileCmd({ messageId: 'write', path: '/Users/not-this-workspace/App.jsx', content: 'bad\n' }),
    /Path is outside this workspace/u,
  );
});
