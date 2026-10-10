import { readdir, readFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const files = [];
async function walk(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    if (item.isDirectory()) await walk(path.join(directory, item.name));
    else if (item.name.endsWith('.mjs')) files.push(path.join(directory, item.name));
  }
}
for (const directory of ['src', 'bin', 'test', 'scripts']) await walk(path.join(root, directory));
for (const file of files.sort()) {
  execFileSync(process.execPath, ['--check', file], { stdio: 'pipe', timeout: 10000 });
  const source = await readFile(file, 'utf8');
  if (source.includes('\r') || /[\t ]+$/mu.test(source) || !source.endsWith('\n')) throw new Error(`Source hygiene failed: ${path.relative(root, file)}`);
}
const pkg = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
const lock = JSON.parse(await readFile(path.join(root, 'package-lock.json'), 'utf8'));
if (pkg.version !== lock.version || pkg.version !== lock.packages[''].version) throw new Error('Package and lockfile versions differ.');
const { VERSION } = await import('../src/report.mjs');
if (pkg.version !== VERSION) throw new Error('CLI and package versions differ.');
console.log(`PASS: syntax and source hygiene for ${files.length} modules; package versions match.`);
