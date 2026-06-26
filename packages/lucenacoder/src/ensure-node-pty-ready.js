import { chmodSync, existsSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);

try {
  const packageJson = require.resolve('node-pty/package.json');
  const root = path.dirname(packageJson);
  const platform = process.platform;
  const arch = process.arch;
  if (platform === 'darwin') {
    const helper = path.join(root, 'prebuilds', `${platform}-${arch}`, 'spawn-helper');
    if (existsSync(helper)) chmodSync(helper, 0o755);
  }
} catch {
  // node-pty is optional at install-script time for some package managers; runtime import will fail loudly.
}
