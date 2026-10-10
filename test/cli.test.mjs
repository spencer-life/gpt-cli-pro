import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, writeFile, rm, mkdir, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { main, parseCLI } from '../src/cli.mjs';
import { MAX_SNAPSHOT_BYTES, makeReport, renderReport, readSnapshot } from '../src/report.mjs';

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

// Injected source metadata exercises cross-machine snapshots; this is not native WSL validation.
function wslSnapshot(root, checks) {
  const environment = { platform: 'linux', arch: 'x64', isWSL: true, wslVersion: 2, home: '/home/fixture',
    mountInfoStatus: 'ok', mountInfoTruncated: false, mounts: [
      { mountPoint: '/', fsType: 'ext4', source: '/dev/root' },
      { mountPoint: '/drives/Shared', fsType: '9p', source: 'D:\\', superOptions: ['aname=drvfs'] },
      { mountPoint: '/drives/Shared/Work/native', fsType: 'ext4', source: '/dev/native' },
    ] };
  return JSON.parse(renderReport(makeReport('doctor', environment, checks, {}, { root }), 'json',
    { project: root, home: environment.home, environment, redact: false }));
}

async function saveSnapshotPair(t, before, after) {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-source-diff-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const files = [path.join(dir, 'before.json'), path.join(dir, 'after.json')];
  await Promise.all([before, after].map((snapshot, index) => writeFile(files[index], JSON.stringify(snapshot))));
  return files;
}

test('snapshot CLI masks Windows mount casing aliases in every diff format (WSL fixture)', async (t) => {
  const root = '/drives/Shared/PrivateTeam/Project';
  const oldAlias = root.toLowerCase(), newAlias = root.toUpperCase();
  const oldCheck = { id: 'project.fixture', status: 'warn', title: `Blocked ${oldAlias}/run.sh`,
    detail: `Observed ${oldAlias}/src/old.js`, evidence: [`${oldAlias}/bin/old`], remedy: `Review ${oldAlias}/settings` };
  const newCheck = { id: oldCheck.id, status: 'pass', title: `Ready ${newAlias}/run.sh`,
    detail: `Observed ${newAlias}/src/new.js`, evidence: [`${newAlias}/bin/new`], remedy: `Check ${newAlias}/settings` };
  const before = wslSnapshot(root, [oldCheck]), after = wslSnapshot(root, [newCheck]);
  assert.equal(before.privacy.projectRootCaseInsensitive, true, 'Confirmed source mount policy must survive export.');
  const files = await saveSnapshotPair(t, before, after);
  for (const format of ['json', 'text', 'markdown']) {
    const result = await run(['diff', ...files, '--format', format]);
    assert.equal(result.code, 1, result.stderr);
    assert.equal(result.stderr, '');
    assert.equal(result.stdout.toLowerCase().includes(root.toLowerCase()), false, `${format} exposed a source-root casing alias.`);
    assert.ok(result.stdout.includes(format === 'markdown' ? '\\<PROJECT\\>' : '<PROJECT>'), `${format} must retain useful relative paths.`);
    if (format === 'json') {
      const [change] = JSON.parse(result.stdout).changed;
      assert.equal(change.before.title, 'Blocked <PROJECT>/run.sh');
      assert.equal(change.after.detail, 'Observed <PROJECT>/src/new.js');
      assert.deepEqual(change.before.evidence, ['<PROJECT>/bin/old']);
      assert.equal(change.after.remedy, 'Check <PROJECT>/settings');
    }
  }
  const exact = await run(['diff', ...files, '--json', '--no-redact']);
  assert.equal(exact.code, 1, exact.stderr);
  assert.deepEqual(JSON.parse(exact.stdout).changed, [{ id: oldCheck.id, before: oldCheck, after: newCheck }]);
});

test('snapshot CLI ignores root-only casing aliases using both recorded roots (WSL fixtures)', async (t) => {
  const firstRoot = '/drives/Shared/PrivateOne/App', secondRoot = '/drives/Shared/PrivateTwo/App';
  const check = { id: 'project.fixture', status: 'warn', title: 'Inspect the script', evidence: [] };
  const before = wslSnapshot(firstRoot, [{ ...check, detail: `${firstRoot.toLowerCase()}/run.sh` }]);
  const after = wslSnapshot(secondRoot, [{ ...check, detail: `${secondRoot.toUpperCase()}/run.sh` }]);
  const result = await run(['diff', ...await saveSnapshotPair(t, before, after), '--json']);
  assert.equal(result.code, 0, result.stderr);
  const diff = JSON.parse(result.stdout);
  assert.deepEqual([diff.added, diff.removed, diff.changed], [[], [], []]);
  assert.equal(diff.unchanged, 1);
});

test('snapshot CLI keeps Windows and nested Linux source policies separate (WSL fixtures)', async (t) => {
  const windowsRoot = '/drives/Shared/Work', linuxRoot = `${windowsRoot}/native/Project`;
  const linuxOtherCase = `${windowsRoot}/native/project/src/file.js`;
  const check = { id: 'project.fixture', status: 'warn', title: 'Inspect the source', evidence: [] };
  const before = wslSnapshot(windowsRoot, [{ ...check, detail: `${windowsRoot.toLowerCase()}/src/file.js` }]);
  const after = wslSnapshot(linuxRoot, [{ ...check, detail: linuxOtherCase }]);
  assert.equal(before.privacy.projectRootCaseInsensitive, true);
  assert.equal(after.privacy.projectRootCaseInsensitive, false, 'The nested Linux mount must override its Windows parent.');
  const result = await run(['diff', ...await saveSnapshotPair(t, before, after), '--json']);
  assert.equal(result.code, 1, result.stderr);
  const diff = JSON.parse(result.stdout);
  assert.equal(diff.changed.length, 1, 'A distinct Linux spelling must remain a finding change.');
  assert.equal(diff.changed[0].before.detail, '<PROJECT>/src/file.js');
  assert.equal(diff.changed[0].after.detail, linuxOtherCase, 'A source policy must not redact the other snapshot.');
});

test('snapshot CLI supports confirmed legacy mount findings but preserves incomplete-source case differences (WSL fixtures)', async (t) => {
  const root = '/drives/Shared/Legacy/Project';
  const location = { id: 'environment.windows-filesystem', status: 'warn', title: 'Windows filesystem', evidence: [root, '9p'] };
  const check = { id: 'project.fixture', status: 'warn', title: 'Inspect the script', evidence: [] };
  const before = wslSnapshot(root, [location, { ...check, detail: `${root.toLowerCase()}/run.sh` }]);
  const after = wslSnapshot(root, [location, { ...check, detail: `${root.toUpperCase()}/run.sh` }]);
  for (const snapshot of [before, after]) delete snapshot.privacy.projectRootCaseInsensitive;
  const files = await saveSnapshotPair(t, before, after);
  const legacy = await run(['diff', ...files, '--json']);
  assert.equal(legacy.code, 0, legacy.stderr);
  assert.equal(JSON.parse(legacy.stdout).unchanged, 2);

  const incomplete = { id: 'environment.mounts-incomplete', status: 'warn', title: 'Mount inventory is incomplete' };
  for (const snapshot of [before, after]) {
    snapshot.checks.push(incomplete);
    snapshot.summary.warn += 1;
  }
  await Promise.all([before, after].map((snapshot, index) => writeFile(files[index], JSON.stringify(snapshot))));
  const unknown = await run(['diff', ...files, '--json']);
  assert.equal(unknown.code, 1, unknown.stderr);
  const [change] = JSON.parse(unknown.stdout).changed;
  assert.equal(change.id, check.id);
  assert.equal(change.before.detail, `${root.toLowerCase()}/run.sh`);
  assert.equal(change.after.detail, `${root.toUpperCase()}/run.sh`);
});

test('main waits for a backpressured stderr callback before returning exit code 2', async () => {
  let written = '', completed = false;
  const io = {
    stdout: { write() { assert.fail('An argument error must not write stdout.'); } },
    stderr: { write(value, done) {
      setTimeout(() => { written += value; completed = true; done?.(); }, 40);
      return false;
    } },
  };
  assert.equal(await main(['not-a-wslens-command'], io), 2);
  assert.equal(completed, true, 'main must not resolve while its error is queued.');
  assert.match(written, /^WSLens: Unknown command not-a-wslens-command/u);
});

test('CLI entrypoint drains delayed stderr before process exit and retains exit status 2', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-stderr-drain-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const destination = path.join(dir, 'captured-stderr.txt');
  const preload = new URL('../scripts/fixtures/stderr-delay.mjs', import.meta.url).href;
  let error;
  try {
    await exec(process.execPath, ['--import', preload, bin, 'not-a-wslens-command'], {
      env: { ...process.env, WSLENS_STDERR_CAPTURE: destination }, timeout: 10000,
    });
  } catch (caught) { error = caught; }
  assert.equal(error?.code, 2, error?.message);
  assert.equal(error.stdout, '');
  const captured = await readFile(destination, 'utf8');
  assert.match(captured, /^WSLens: Unknown command not-a-wslens-command\. Run wslens --help\.\n$/u);
});


test('large generated snapshots can be captured, imported, and compared by the actual CLI', async (t) => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-large-snapshot-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const reports = ['before.json', 'after.json'].map(name => path.join(dir, name));
  const commands = Array.from({ length: 20 }, (_, commandIndex) => ({
    name: 'tool' + commandIndex, selected: '/tools/tool' + commandIndex,
    candidates: Array.from({ length: 256 }, (_, index) => {
      const filename = '/mnt/c/' + 'long-directory-'.repeat(32) + '/' + index + '/tool' + commandIndex;
      return { path: filename, realPath: filename, executable: true, matchesName: true, kind: 'file', pathIndex: index };
    }),
    complete: true, observedFirst: '/tools/tool' + commandIndex, note: 'PATH selection is known.',
  }));
  for (const [index, filename] of reports.entries()) {
    const report = makeReport('which', { platform: 'linux', arch: 'x64', isWSL: false }, [
      { id: 'which.fixture', status: index ? 'pass' : 'warn', title: 'Fixture status', detail: 'Changes across snapshots' },
    ], { commands });
    const output = renderReport(report, 'json', { redact: false });
    assert.ok(Buffer.byteLength(output, 'utf8') <= MAX_SNAPSHOT_BYTES);
    await writeFile(filename, output);
    const loaded = await readSnapshot(filename);
    assert.equal(loaded.checks.at(-1).id, 'report.snapshot-limited');
    assert.ok(loaded.data.inventoryLimit.omittedCandidates > 0);
  }
  const compared = await run(['diff', ...reports, '--json']);
  assert.equal(compared.code, 1, compared.stderr);
  assert.equal(compared.stderr, '');
  const diff = JSON.parse(compared.stdout);
  assert.deepEqual(diff.changed.map(change => change.id), ['which.fixture']);
  assert.equal(diff.unchanged, 1, 'Truncation warning stays stable across captures.');
  const identical = await run(['diff', reports[0], reports[0], '--json']);
  assert.equal(identical.code, 0, identical.stderr);
  assert.deepEqual(JSON.parse(identical.stdout).changed, []);
});
