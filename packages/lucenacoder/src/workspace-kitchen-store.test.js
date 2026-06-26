import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  indexWorkspaceKitchenPath,
  readWorkspaceKitchenSqliteBytes,
  removeWorkspaceKitchenPath,
} from './workspace-kitchen-store.js';

test('Workspace Kitchen indexes host absolute paths inside the tunnel workspace', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lucena-kitchen-absolute-'));
  await mkdir(join(root, 'src', 'styles'), { recursive: true });
  const cssPath = join(root, 'src', 'styles', 'collection.css');
  await writeFile(cssPath, '.collection { display: grid; }\n', 'utf-8');

  const result = await indexWorkspaceKitchenPath(root, cssPath);
  assert.equal(result.indexed, 1);
  assert.deepEqual(result.paths, [`${root}/src/styles/collection.css`]);

  const bytes = await readWorkspaceKitchenSqliteBytes(root);
  assert.ok(bytes.length > 100);
});

test('Workspace Kitchen keeps workspace-root paths and rejects outside absolute paths', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lucena-kitchen-relative-'));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src', 'App.jsx'), 'export default function App() { return null; }\n', 'utf-8');

  const relativeResult = await indexWorkspaceKitchenPath(root, '/src/App.jsx');
  assert.equal(relativeResult.indexed, 1);
  assert.deepEqual(relativeResult.paths, [`${root}/src/App.jsx`]);

  const outsideResult = await indexWorkspaceKitchenPath(root, '/Users/not-this-workspace/src/App.jsx');
  assert.deepEqual(outsideResult, { indexed: 0, removed: 0, paths: [] });

  const removeOutsideResult = await removeWorkspaceKitchenPath(root, '/Users/not-this-workspace/src/App.jsx');
  assert.deepEqual(removeOutsideResult, { removed: 0, paths: [] });
});
