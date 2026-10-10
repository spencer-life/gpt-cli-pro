import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { quotePath } from '../src/paths.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const npm = process.env.npm_execpath;
if (!npm) throw new Error('Run this check through npm run pack:check.');
const dir = await mkdtemp(path.join(tmpdir(), 'wslens-package-'));
const runNpm = args => execFileSync(process.execPath, [npm, ...args], { cwd: root, encoding: 'utf8', timeout: 60000, env: { ...process.env, npm_config_update_notifier: 'false' } });
try {
  const [packed] = JSON.parse(runNpm(['pack', '--json', '--ignore-scripts', '--pack-destination', dir]));
  const filenames = packed.files.map(item => item.path);
  assert.ok(filenames.includes('bin/wslens.mjs'));
  assert.ok(filenames.includes('src/cli.mjs'));
  assert.ok(filenames.includes('LICENSE'));
  assert.ok(!filenames.some(name => name.startsWith('test/') || name.startsWith('scripts/') || name.startsWith('.github/')));
  const prefix = path.join(dir, 'installed with spaces');
  runNpm(['install', '--global', '--prefix', prefix, '--ignore-scripts', '--no-audit', '--no-fund', '--offline', path.join(dir, packed.filename)]);
  const packageDir = process.platform === 'win32'
    ? path.join(prefix, 'node_modules', '@spencer-life', 'wslens')
    : path.join(prefix, 'lib', 'node_modules', '@spencer-life', 'wslens');
  const pkg = JSON.parse(await readFile(path.join(packageDir, 'package.json'), 'utf8'));
  const shipped = new Set(filenames);
  for (const filename of filenames.filter(name => name.endsWith('.md'))) {
    const document = await readFile(path.join(packageDir, filename), 'utf8');
    for (const [, link] of document.matchAll(/\[[^\]]*\]\(([^)\s]+)\)/gu)) {
      if (/^(?:[a-z][a-z0-9+.-]*:|#)/iu.test(link)) continue;
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(filename), link.split(/[?#]/u)[0]));
      assert.ok(shipped.has(target), `Packaged documentation link is missing: ${filename} -> ${link}`);
    }
  }
  const output = execFileSync(process.execPath, [path.join(packageDir, 'bin', 'wslens.mjs'), '--version'], { encoding: 'utf8' }).trim();
  assert.equal(output, pkg.version);
  const translated = execFileSync(process.execPath, [path.join(packageDir, 'bin', 'wslens.mjs'), 'path', 'C:\\Users\\Ada\\app'], { encoding: 'utf8' }).trim();
  assert.equal(translated, '/mnt/c/Users/Ada/app');
  const shim = process.platform === 'win32' ? path.join(prefix, 'wslens.cmd') : path.join(prefix, 'bin', 'wslens');
  assert.ok((await stat(shim)).isFile());
  if (process.platform === 'win32') {
    const powershell = path.win32.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
    const script = '& ' + quotePath(shim, 'powershell') + ' --version; exit $LASTEXITCODE';
    assert.equal(execFileSync(powershell, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', timeout: 15000 }).trim(), pkg.version);
  } else assert.equal(execFileSync(shim, ['--version'], { encoding: 'utf8' }).trim(), pkg.version);
  console.log(`PASS: ${packed.filename} (${packed.size} bytes, ${filenames.length} files) installed offline; documentation links, CLI, and executable shim verified.`);
} finally { await rm(dir, { recursive: true, force: true }); }
