import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const coderPath = join(root, 'packages/lucenacoder/package.json');
const aliasPath = join(root, 'packages/lucenacoderalias/package.json');

const coderPkg = JSON.parse(readFileSync(coderPath, 'utf8'));
const aliasPkg = JSON.parse(readFileSync(aliasPath, 'utf8'));

aliasPkg.version = coderPkg.version;
aliasPkg.dependencies['@lucenaone/coder'] = coderPkg.version;

writeFileSync(aliasPath, `${JSON.stringify(aliasPkg, null, 2)}\n`);
console.log(`synced lucenacoder alias -> v${coderPkg.version} (@lucenaone/coder@${coderPkg.version})`);
