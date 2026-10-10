import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const root = await mkdtemp(path.join(tmpdir(), 'wslens-demo-'));
try {
  await mkdir(path.join(root, 'scripts'));
  await writeFile(path.join(root, 'scripts', 'start.sh'), '#!/bin/sh\r\necho demo\r\n');
  await writeFile(path.join(root, '.env'), 'EXAMPLE_SECRET=not-read-by-wslens');
  if (process.platform !== 'win32') {
    await mkdir(path.join(root, 'Src'));
    await mkdir(path.join(root, 'src'));
    await writeFile(path.join(root, 'Src', 'App.js'), 'export {};\n');
    await writeFile(path.join(root, 'src', 'app.js'), 'export {};\n');
    await writeFile(path.join(root, 'CON.txt'), 'Windows-incompatible name\n');
  }
  console.log('Demonstration using a disposable project with deliberate portability problems.\n');
  const bin = fileURLToPath(new URL('../bin/wslens.mjs', import.meta.url));
  let result;
  try { result = await run(process.execPath, [bin, 'doctor', root, '--tools', 'node', '--no-color'], { timeout: 10000 }); }
  catch (error) { if (![0, 1].includes(error.code)) throw error; result = error; }
  process.stdout.write(result.stdout);
  if (result.stderr) process.stderr.write(result.stderr);
} finally { await rm(root, { recursive: true, force: true }); }
