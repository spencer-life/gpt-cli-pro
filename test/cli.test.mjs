import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseCLI } from '../src/cli.mjs';

const exec = promisify(execFile);
const bin = fileURLToPath(new URL('../bin/wslens.mjs', import.meta.url));
async function run(args, options = {}) {
  try { const result = await exec(process.execPath, [bin, ...args], { timeout: 10000, ...options }); return { ...result, code: 0 }; }
  catch (error) { if (typeof error.code !== 'number') throw error; return { stdout: error.stdout, stderr: error.stderr, code: error.code }; }
}

test('argument validation rejects mistakes instead of silently ignoring flags', () => {
  for (const args of [
    ['doctor', '--typo'], ['wat'], ['constructor'], ['__proto__'], ['toString'], ['ports', '0'], ['ports', '65536'], ['ports', '3.1'],
    ['ports', '--probe'], ['which'], ['which', 'node;echo'], ['which', 'C:\\node.exe'],
    ['doctor', '.', '--project', '.'], ['doctor', '--tools', 'node,'], ['doctor', '--tools', ''],
    ['doctor', '--json', '--format', 'text'], ['doctor', '--json', '--json'], ['which', 'node', '--probe'],
    ['path', '/mnt/c', '--format', 'markdown'], ['path', '/mnt/c', '--strict'], ['diff', 'one'],
  ]) assert.throws(() => parseCLI(args), undefined, args.join(' '));
  assert.equal(parseCLI(['ports', '--port=3000', '--probe']).port, 3000);
  assert.equal(parseCLI(['report']).format, 'markdown');
  assert.deepEqual(parseCLI(['which', 'node', 'node']).names, ['node']);
  for (const directory of [' ', '  project name  ']) {
    assert.equal(parseCLI(['doctor', '--project', directory]).values.project, directory);
    assert.deepEqual(parseCLI(['report', directory]).args, [directory]);
  }
  for (const quote of ['bash', 'powershell']) assert.equal(parseCLI(['path', 'C:\\work', '--quote', quote]).values.quote, quote);
});

test('empty project arguments and conflicting empty options fail before producing a report', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-empty-arguments-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const target = path.join(dir, 'explicit target');
  await mkdir(target);
  const cases = ['doctor', 'report'].flatMap(command => [
    { args: [command, '--project', ''], message: /Project directory must not be empty/u },
    { args: [command, target, '--project', ''], message: /Choose one project directory/u },
    { args: [command, ''], message: /Project directory must not be empty/u },
  ]);
  cases.push(
    { args: ['ports', '3000', '--port', ''], message: /Choose one port/u },
    { args: ['doctor', '--json', '--format', ''], message: /--json conflicts with --format/u },
  );
  for (const [index, fixture] of cases.entries()) {
    const output = path.join(dir, `unexpected-report-${index}.txt`);
    const result = await run([...fixture.args, '--output', output], { cwd: dir, env: { ...process.env, PATH: '' } });
    assert.equal(result.code, 2, JSON.stringify(fixture.args));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, fixture.message);
    await assert.rejects(lstat(output), { code: 'ENOENT' });
  }
});

test('empty or invalid explicit quote modes never emit an unquoted path', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-empty-quote-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  for (const quote of ['', 'cmd', ' bash ']) {
    const result = await run(['path', 'C:\\work', '--quote', quote]);
    assert.equal(result.code, 2, JSON.stringify(quote));
    assert.equal(result.stdout, '');
    assert.match(result.stderr, /--quote must be bash or powershell/u);
  }
  const output = path.join(dir, 'unexpected-path.txt');
  const saved = await run(['path', 'C:\\work', '--quote', '', '--output', output]);
  assert.equal(saved.code, 2);
  assert.equal(saved.stdout, '');
  assert.match(saved.stderr, /--quote must be bash or powershell/u);
  await assert.rejects(lstat(output), { code: 'ENOENT' });
});

test('help/version/path work as installed command entrypoints', async () => {
  assert.match((await run(['--help'])).stdout, /Commands:/u);
  assert.equal((await run(['--version'])).stdout.trim(), '0.1.0');
  const result = await run(['path', 'C:\\Users\\Ada\\My app', '--quote', 'bash']);
  assert.equal(result.code, 0);
  assert.equal(result.stdout.trim(), "'/mnt/c/Users/Ada/My app'");
  const json = JSON.parse((await run(['path', '/mnt/d/app', '--json'])).stdout);
  assert.equal(json.output, 'D:\\app');
  assert.equal(json.mapping, 'lexical');
});

test('unknown command fails on stderr with no JSON contamination', async () => {
  const result = await run(['docotr', '--json']);
  assert.equal(result.code, 2);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /Unknown command/u);
});

test('doctor emits usable JSON, detects a real CRLF script, and never runs it', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'wslens-cli-'));
  try {
    await mkdir(path.join(root, 'scripts'));
    const script = path.join(root, 'scripts', 'run.sh');
    await writeFile(script, '#!/bin/sh\r\necho should-never-run\r\n');
    await writeFile(path.join(root, '.env'), 'SECRET=should-not-appear');
    const result = await run(['doctor', root, '--json', '--format', 'json', '--tools', 'node']);
    assert.notEqual(result.code, 2, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.command, 'doctor');
    assert.equal(report.project.root, '<PROJECT>');
    assert.ok(report.checks.some(check => /crlf/u.test(check.id)));
    assert.ok(!result.stdout.includes('should-never-run'));
    assert.ok(!result.stdout.includes('should-not-appear'));
    assert.equal(await readFile(script, 'utf8'), '#!/bin/sh\r\necho should-never-run\r\n');
    const strict = await run(['doctor', root, '--strict', '--tools', 'node']);
    assert.equal(strict.code, 1);
    const markdown = await run(['report', root, '--tools', 'node']);
    assert.match(markdown.stdout, /^# WSLens/u);
    assert.ok(markdown.stdout.includes('Next step'));
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('which reports missing requested executables with exit 1', async () => {
  const result = await run(['which', 'wslens-definitely-no-such-command-731204', '--json']);
  assert.equal(result.code, 1);
  const report = JSON.parse(result.stdout);
  assert.ok(report.checks.some(check => check.id === 'which.requested-unresolved'));
  assert.equal(report.data.commands[0].selected, null);
});

test('doctor and report reject an explicit symlink or junction root before creating a report', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-root-link-'));
  try {
    const target = path.join(dir, 'target');
    const link = path.join(dir, 'alias');
    const output = path.join(dir, 'report.json');
    await mkdir(target);
    await writeFile(path.join(target, 'private-name.sh'), '#!/bin/sh\r\necho target-must-not-be-inspected\r\n');
    await symlink(target, link, process.platform === 'win32' ? 'junction' : 'dir');
    for (const command of ['doctor', 'report']) {
      const result = await run([command, '--project', link, '--json', '--output', output]);
      assert.equal(result.code, 2);
      assert.equal(result.stdout, '');
      assert.match(result.stderr, /must not be a symlink or junction/u);
      assert.ok(!result.stderr.includes('private-name'));
      await assert.rejects(lstat(output), { code: 'ENOENT' });
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('explicit report file creation refuses overwrites, including source files', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-output-'));
  try {
    const file = path.join(dir, 'out.json');
    const args = ['path', 'C:\\work', '--json', '--output', file];
    const result = await run(args);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, '');
    const before = await readFile(file, 'utf8');
    assert.equal(JSON.parse(before).output, '/mnt/c/work');
    const repeat = await run(args);
    assert.equal(repeat.code, 2);
    assert.match(repeat.stderr, /does not overwrite/u);
    assert.equal(await readFile(file, 'utf8'), before);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('a color-capable terminal keeps interactive colors but saves text reports without escape bytes', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-output-color-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  let printed = '';
  const io = {
    cwd: dir, env: { PATH: '', TERM: 'xterm-256color' },
    stdout: { isTTY: true, write(text, callback) { printed += text; callback?.(); return true; } },
    stderr: { write(text) { assert.fail(text); } },
  };
  const args = ['which', 'wslens-definitely-no-such-command-731204', '--format', 'text'];
  assert.equal(await main(args, io), 1);
  assert.match(printed, /\u001b\[/u, 'Interactive text must still support ANSI color.');
  printed = '';
  const output = path.join(dir, 'report.txt');
  assert.equal(await main([...args, '--output', output], io), 1);
  assert.equal(printed, '');
  const saved = await readFile(output);
  assert.equal(saved.includes(0x1b), false, 'Saved text must not contain an escape byte.');
  assert.match(saved.toString('utf8'), /^WSLens /u);
  assert.match(saved.toString('utf8'), /which\.requested-unresolved/u);
});

test('snapshot CLI ignores timestamps, detects changes, and masks recorded project roots', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-diff-'));
  try {
    const before = path.join(dir, 'before.json'), after = path.join(dir, 'after.json');
    const original = { schemaVersion: 1, tool: { name: 'wslens' }, command: 'doctor', project: { root: '/private/project-name' },
      checks: [{ id: 'one', status: 'warn', title: 'Test', detail: '/private/project-name/run.sh', evidence: [] }] };
    await writeFile(before, JSON.stringify(original));
    await writeFile(after, JSON.stringify({ ...original, generatedAt: 'later' }));
    assert.equal((await run(['diff', before, after])).code, 0);
    await writeFile(after, JSON.stringify({ ...original, checks: [{ ...original.checks[0], status: 'pass' }] }));
    const changed = await run(['diff', before, after, '--json']);
    assert.equal(changed.code, 1);
    assert.equal(JSON.parse(changed.stdout).changed.length, 1);
    assert.ok(!changed.stdout.includes('/private/project-name'));
    assert.ok(changed.stdout.includes('<PROJECT>/run.sh'));
  } finally { await rm(dir, { recursive: true, force: true }); }
});
