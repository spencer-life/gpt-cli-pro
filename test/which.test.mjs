import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, chmod, symlink, rm, access } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectCommands, inspectPath, parsePathEntries, parsePathExt, validCommandName } from '../src/which.mjs';

const posixOptions = { skip: process.platform === 'win32' ? 'Native POSIX execute bits and symlinks are tested on Linux/macOS; Windows uses injected fixtures below.' : false };

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'wslens-which-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function executable(directory, name, mode = 0o755) {
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, name);
  await writeFile(file, '#!/bin/sh\nprintf "This file must never be executed"\n', { mode });
  await chmod(file, mode);
  return file;
}

function environment(cwd, pathValue, extra = {}) {
  return { platform: 'linux', cwd, pathValue, pathDefined: true, isWSL: false, ...extra };
}

function posixExecutableFixture(file, target = file) {
  const requireFile = (value) => {
    if (value !== file) throw Object.assign(new Error('fixture file missing'), { code: 'ENOENT' });
  };
  const regular = { mode: 0o755, isFile: () => true, isDirectory: () => false, isSymbolicLink: () => false };
  return {
    async lstat(value) { requireFile(value); return { ...regular, isSymbolicLink: () => target !== file }; },
    async stat(value) { requireFile(value); return regular; },
    async realpath(value) { requireFile(value); return target; },
    async access(value) { requireFile(value); },
  };
}

function windowsFixture(fileRecords, { denied = [], directoryEntries } = {}) {
  const records = new Map();
  const key = (value) => path.win32.normalize(value).toLowerCase();
  const missing = () => Object.assign(new Error('fixture file missing'), { code: 'ENOENT' });
  const deny = new Set(denied.map(key));
  function addDirectory(value) {
    const normalized = path.win32.normalize(value);
    const normalizedKey = key(normalized);
    if (records.has(normalizedKey)) return;
    records.set(normalizedKey, { path: normalized, type: 'directory' });
    const parent = path.win32.dirname(normalized);
    if (key(parent) !== normalizedKey) addDirectory(parent);
  }
  for (const value of fileRecords) {
    const record = typeof value === 'string' ? { path: value, type: 'file' } : value;
    addDirectory(path.win32.dirname(record.path));
    records.set(key(record.path), { type: 'file', ...record });
  }
  function recordFor(value, follow = true) {
    const record = records.get(key(value));
    if (!record) throw missing();
    if (record.type === 'symlink' && follow) return recordFor(record.target, true);
    return record;
  }
  function statFor(record) {
    return { mode: record.mode ?? 0o755, isFile: () => record.type === 'file',
      isDirectory: () => record.type === 'directory', isSymbolicLink: () => record.type === 'symlink' };
  }
  return {
    async lstat(value) { return statFor(recordFor(value, false)); },
    async stat(value) { return statFor(recordFor(value)); },
    async realpath(value) { return recordFor(value).path; },
    async access(value) { recordFor(value); },
    async opendir(value) {
      if (deny.has(key(value))) throw Object.assign(new Error('fixture denied'), { code: 'EACCES' });
      if (directoryEntries) return directoryEntries(value);
      if (recordFor(value).type !== 'directory') throw Object.assign(new Error('fixture is not a directory'), { code: 'ENOTDIR' });
      const children = [...records.values()].filter((record) => key(path.win32.dirname(record.path)) === key(value) && key(record.path) !== key(value));
      let index = 0;
      return { async read() { return index < children.length ? { name: path.win32.basename(children[index++].path) } : null; }, async close() {} };
    },
  };
}

test('PATH order skips a non-executable match and exposes later candidates', posixOptions, async (t) => {
  const root = await fixture(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  const third = path.join(root, 'third');
  await executable(first, 'tool', 0o644);
  const chosen = await executable(second, 'tool');
  await executable(third, 'tool');
  const result = await inspectCommands(['tool'], environment(root, [first, second, third].join(':')));
  assert.equal(result.commands[0].selected, chosen);
  assert.deepEqual(result.commands[0].candidates.map((candidate) => candidate.executable), [false, true, true]);
  assert.equal(result.checks.find((finding) => finding.id === 'which.nonexecutable').status, 'info');
  assert.equal(result.checks.find((finding) => finding.id === 'which.multiple').status, 'info');
  assert.equal(result.commands[0].complete, true);
});

test('symlinks expose their target and duplicate real files are not called multiple installs', posixOptions, async (t) => {
  const root = await fixture(t);
  const bin = path.join(root, 'bin');
  const target = await executable(path.join(root, 'actual'), 'tool');
  await mkdir(bin);
  await symlink(target, path.join(bin, 'tool'));
  const result = await inspectCommands(['tool'], environment(root, `${bin}:${path.dirname(target)}`));
  assert.equal(result.commands[0].selected, path.join(bin, 'tool'));
  assert.equal(result.commands[0].candidates[0].kind, 'symlink');
  assert.equal(result.commands[0].candidates[0].realPath, target);
  assert(!result.checks.some((finding) => finding.id === 'which.multiple'));
});

test('symlinked PATH directories canonicalize to the same real candidate', posixOptions, async (t) => {
  const root = await fixture(t);
  const actual = path.join(root, 'actual');
  const target = await executable(actual, 'tool');
  const linked = path.join(root, 'linked');
  await symlink(actual, linked, 'dir');
  const result = await inspectCommands(['tool'], environment(root, `${linked}:${actual}`));
  assert.equal(result.commands[0].candidates[0].realPath, target);
  assert(!result.checks.some((finding) => finding.id === 'which.multiple'));
});

test('broken symlinks are explained and a directory with the command name is excluded', posixOptions, async (t) => {
  const root = await fixture(t);
  const first = path.join(root, 'first');
  const second = path.join(root, 'second');
  await mkdir(first);
  await mkdir(path.join(second, 'tool'), { recursive: true });
  await symlink(path.join(root, 'missing'), path.join(first, 'tool'));
  const result = await inspectCommands(['tool'], environment(root, `${first}:${second}`));
  assert.equal(result.commands[0].selected, null);
  assert.equal(result.commands[0].candidates.length, 1);
  assert.equal(result.commands[0].candidates[0].realPath, null);
  assert.match(result.commands[0].candidates[0].reason, /ENOENT/);
  assert.equal(result.checks.find((finding) => finding.id === 'which.nonexecutable').status, 'warn');
});

test('missing optional commands remain informational and absent directories are complete results', async (t) => {
  const root = await fixture(t);
  const missing = path.join(root, 'missing');
  const env = environment(root, missing, { platform: process.platform });
  const commands = await inspectCommands(['not-installed'], env);
  assert.equal(commands.commands[0].selected, null);
  assert.equal(commands.commands[0].complete, true);
  assert.equal(commands.checks.find((finding) => finding.id === 'which.missing').status, 'info');
  assert(!commands.checks.some((finding) => finding.id === 'which.incomplete'));
  const paths = await inspectPath(env);
  assert.equal(paths.entries[0].exists, false);
  assert.equal(paths.checks.find((finding) => finding.id === 'path.missing').status, 'info');
});

test('empty and relative POSIX PATH entries search cwd and preserve their hygiene findings', posixOptions, async (t) => {
  const root = await fixture(t);
  const selected = await executable(root, 'tool');
  await mkdir(path.join(root, 'relative'));
  const env = environment(root, ':relative:.');
  const paths = await inspectPath(env);
  assert.equal(paths.entries[0].path, root);
  assert.equal(paths.entries[2].duplicateOf, 0);
  assert(paths.checks.some((finding) => finding.id === 'path.empty'));
  assert(paths.checks.some((finding) => finding.id === 'path.relative'));
  assert(paths.checks.some((finding) => finding.id === 'path.duplicates'));
  assert.equal((await inspectCommands(['tool'], env)).commands[0].selected, selected);
});

test('Windows quoted segments preserve spaces and embedded semicolons; POSIX quotes stay literal', () => {
  const entries = parsePathEntries('"C:\\Tools;Extra";"C:\\Program Files\\Node";C:\\Tools', 'win32', 'C:\\work');
  assert.deepEqual(entries.map((entry) => entry.path), ['C:\\Tools;Extra', 'C:\\Program Files\\Node', 'C:\\Tools']);
  assert.equal(entries[0].quoted, true);
  assert.equal(parsePathEntries('"/usr/bin"', 'linux', '/project')[0].path, '/project/"/usr/bin"');
  assert.equal(parsePathEntries('"C:\\broken', 'win32', 'C:\\work')[0].invalid, true);
  const driveRooted = parsePathEntries('\\Tools', 'win32', 'C:\\work')[0];
  assert.equal(driveRooted.path, 'C:\\Tools');
  assert.equal(driveRooted.relative, true);
});

test('Windows directory and filename case are ignored while PATH and PATHEXT order are respected', async () => {
  const fs = windowsFixture(['C:\\Tools With Spaces\\Node.EXE', 'C:\\Tools With Spaces\\NODE.CMD', 'C:\\Second\\node.exe']);
  const env = environment('C:\\work', '"C:\\Tools With Spaces";C:\\Second;C:\\tools with spaces\\;C:\\missing',
    { platform: 'win32', pathExt: '.CMD;.EXE;.cmd', fs });
  const result = await inspectCommands(['nOdE', 'NODE'], env);
  assert.equal(result.commands.length, 1);
  assert.equal(result.commands[0].selected, 'C:\\Tools With Spaces\\NODE.CMD');
  assert.equal(result.commands[0].candidates.length, 3);
  assert.match(result.commands[0].note, /Shell aliases/);
  const paths = await inspectPath(env);
  assert.equal(paths.entries[2].duplicateOf, 0);
  assert.equal(paths.entries[3].exists, false);
  assert.equal((await inspectCommands(['node'], { ...env, pathExt: '.EXE;.CMD' })).commands[0].selected, 'C:\\Tools With Spaces\\Node.EXE');
});

test('Windows explicit .cmd/.exe names resolve case-insensitively without adding an extension twice', async () => {
  const env = environment('C:\\work', 'C:\\Tools', { platform: 'win32', pathExt: '.EXE;.CMD',
    fs: windowsFixture(['C:\\Tools\\Node.EXE', 'C:\\Tools\\NODE.CMD']) });
  const result = await inspectCommands(['node.cmd', 'NODE.EXE'], env);
  assert.equal(result.commands[0].selected, 'C:\\Tools\\NODE.CMD');
  assert.equal(result.commands[1].selected, 'C:\\Tools\\Node.EXE');
  assert.equal(result.commands[0].candidates.length, 1);
});

test('Windows npm.ps1 is shown beside npm.cmd while selection stays explicitly PATHEXT-based', async () => {
  const env = environment('C:\\work', 'C:\\Tools', { platform: 'win32',
    fs: windowsFixture(['C:\\Tools\\npm.cmd', 'C:\\Tools\\npm.PS1']) });
  const result = await inspectCommands(['npm'], env);
  const command = result.commands[0];
  assert.equal(command.selected, 'C:\\Tools\\npm.cmd');
  assert.equal(command.complete, true);
  assert.equal(command.candidates.length, 2);
  const script = command.candidates.find((candidate) => candidate.path.endsWith('.PS1'));
  assert.equal(script.kind, 'powershell-script');
  assert.equal(script.matchesName, false);
  assert.equal(script.executable, false);
  assert.equal(script.shellDependent, true);
  assert.match(script.reason, /outside PATHEXT/);
  assert.match(command.note, /PowerShell may choose a \.ps1 script instead of the selected PATHEXT candidate/);
  const finding = result.checks.find((check) => check.id === 'which.powershell-script');
  assert.equal(finding.status, 'info');
  assert(finding.evidence.some((value) => value.includes('C:\\Tools\\npm.PS1')));
  assert.match(finding.remedy, /Get-Command <name> -All/);
  assert.match(finding.detail, /execution policy, ACLs, and script validity were not inspected/);
  assert(!result.checks.some((check) => ['warn', 'fail'].includes(check.status)));
});

test('an explicit Windows .ps1 request is observed without asserting PATHEXT or policy eligibility', async () => {
  const env = environment('C:\\work', 'C:\\Tools', { platform: 'win32',
    fs: windowsFixture(['C:\\Tools\\npm.ps1', 'C:\\Tools\\npm.cmd']) });
  const result = await inspectCommands(['npm.PS1'], env);
  const command = result.commands[0];
  assert.equal(command.selected, null);
  assert.equal(command.observedFirst, null);
  assert.equal(command.complete, true);
  assert.equal(command.candidates.length, 1);
  assert.equal(command.candidates[0].path, 'C:\\Tools\\npm.ps1');
  assert.equal(command.candidates[0].matchesName, false);
  assert.equal(command.candidates[0].shellDependent, true);
  assert.match(command.note, /PowerShell may resolve the observed \.ps1 script/);
  assert.match(command.note, /Windows ACLs were not inspected/);
  assert.equal(result.checks.find((check) => check.id === 'which.powershell-script').status, 'info');
  assert(!result.checks.some((check) => check.id === 'which.nonexecutable' || check.id === 'which.nearby'));
  assert(!result.checks.some((check) => ['warn', 'fail'].includes(check.status)));
});

test('an explicit .PS1 PATHEXT entry preserves extension order without duplicate script candidates', async () => {
  const env = environment('C:\\work', 'C:\\Tools', { platform: 'win32', pathExt: '.CMD;.PS1;.EXE',
    fs: windowsFixture(['C:\\Tools\\npm.ps1', 'C:\\Tools\\npm.cmd']) });
  const result = await inspectCommands(['npm'], env);
  assert.equal(result.commands[0].selected, 'C:\\Tools\\npm.cmd');
  assert.equal(result.commands[0].candidates.length, 2);
  assert.equal(result.commands[0].candidates.find((candidate) => candidate.shellDependent).matchesName, true);
  const reordered = await inspectCommands(['npm'], { ...env, pathExt: '.PS1;.CMD' });
  assert.equal(reordered.commands[0].selected, 'C:\\Tools\\npm.ps1');
  assert.match(reordered.commands[0].note, /selected PATHEXT candidate is a PowerShell script/);
});

test('Windows lookup excludes implicit cwd, Unix extensionless wrappers, and unresolved other-drive paths', async () => {
  const fs = windowsFixture(['C:\\work\\node.exe', 'C:\\Tools\\npm', 'C:\\work\\bin\\local.exe']);
  const env = environment('C:\\work', 'C:\\Tools;;.\\bin;D:tools', { platform: 'win32', fs });
  const result = await inspectCommands(['node', 'npm', 'local'], env);
  assert.equal(result.commands[0].selected, null);
  assert.equal(result.commands[1].selected, null);
  assert.equal(result.commands[1].candidates[0].executable, false);
  assert.equal(result.commands[2].selected, 'C:\\work\\bin\\local.exe');
  const paths = await inspectPath(env);
  assert.equal(paths.entries[1].path, null);
  assert.equal(paths.entries[3].path, null);
  assert(paths.checks.some((finding) => finding.id === 'path.incomplete'));
});

test('PATHEXT parsing preserves precedence and rejects path syntax', () => {
  assert.deepEqual(parsePathExt(undefined), ['.com', '.exe', '.bat', '.cmd']);
  assert.deepEqual(parsePathExt('.CMD;.exe;.EXE;../bad;.ps1;bad; .BAT '), ['.cmd', '.exe', '.ps1', '.bat']);
  assert.deepEqual(parsePathExt(''), []);
});

test('WSL shows nearby Windows executables but does not append PATHEXT', posixOptions, async (t) => {
  const root = await fixture(t);
  const selected = await executable(root, 'node.exe');
  await executable(root, 'explorer.exe');
  const env = environment(root, root, { isWSL: true, pathExt: '.EXE;.CMD' });
  const bare = await inspectCommands(['node'], env);
  assert.equal(bare.commands[0].selected, null);
  assert.equal(bare.commands[0].candidates[0].path, selected);
  assert.equal(bare.commands[0].candidates[0].matchesName, false);
  assert(bare.checks.some((finding) => finding.id === 'which.nearby'));
  const explicit = await inspectCommands(['node.exe', 'explorer.exe'], env);
  assert.equal(explicit.commands[0].selected, selected);
  assert.equal(explicit.checks.find((finding) => finding.id === 'which.windows-runtime').evidence.length, 1);
});

test('an extensionless selected npm wrapper is located by its canonical path on a confirmed Windows mount', async () => {
  const selected = '/home/dev/bin/npm';
  const target = '/mnt/c/Program Files/nodejs/npm';
  const env = environment('/home/dev/project', '/home/dev/bin', { isWSL: true,
    mounts: [{ mountPoint: '/', fsType: 'ext4', source: '/dev/sdc' },
      { mountPoint: '/mnt/c', fsType: '9p', source: 'C:\\', superOptions: ['aname=drvfs'] }],
    fs: posixExecutableFixture(selected, target) });
  const result = await inspectCommands(['npm'], env);
  assert.equal(result.commands[0].selected, selected);
  assert.equal(result.commands[0].candidates[0].realPath, target);
  const finding = result.checks.find((check) => check.id === 'which.windows-filesystem');
  assert.equal(finding.status, 'warn');
  assert(finding.evidence.some((value) => value.includes(target)));
  assert.match(finding.detail, /does not establish the interpreter or runtime architecture/);
  assert(!result.checks.some((check) => check.id === 'which.windows-runtime'));
});

test('tool location does not warn on conventional-only, unknown, nested Linux, or truncated mount evidence', async () => {
  const selected = '/mnt/c/Program Files/nodejs/npm';
  const base = environment('/home/dev/project', '/mnt/c/Program Files/nodejs', { isWSL: true,
    fs: posixExecutableFixture(selected) });
  const drive = { mountPoint: '/mnt/c', fsType: 'drvfs', source: 'C:\\' };
  for (const metadata of [
    { mounts: [] },
    { mounts: [{ mountPoint: '/mnt/c', fsType: 'unknown', source: 'unknown' }] },
    { mounts: [drive, { mountPoint: '/mnt/c/Program Files/nodejs', fsType: 'ext4', source: '/dev/sdc' }] },
    { mounts: [drive], mountInfoTruncated: true },
  ]) {
    const result = await inspectCommands(['npm'], { ...base, ...metadata });
    assert.equal(result.commands[0].selected, selected);
    assert(!result.checks.some((check) => check.id === 'which.windows-filesystem'));
  }
});

test('common version-manager shims do not cause warning findings', posixOptions, async (t) => {
  const root = await fixture(t);
  const bin = path.join(root, '.local', 'share', 'mise', 'shims');
  await executable(bin, 'node');
  const result = await inspectCommands(['node'], environment(root, bin, { isWSL: true }));
  assert.equal(result.commands[0].candidates[0].kind, 'shim');
  assert(!result.checks.some((finding) => ['warn', 'fail'].includes(finding.status)));
});

test('filenames containing shell syntax are inspected literally and never executed', posixOptions, async (t) => {
  const root = await fixture(t);
  const name = 'tool;$(touch WSLENS_SHOULD_NOT_EXIST)';
  const selected = await executable(root, name);
  const result = await inspectCommands([name], environment(root, root));
  assert.equal(result.commands[0].selected, selected);
  await assert.rejects(access(path.join(root, 'WSLENS_SHOULD_NOT_EXIST')));
  assert.equal(validCommandName(name), true);
  assert.equal(validCommandName('../tool'), false);
  assert.equal(validCommandName('tool\nnext'), false);
  assert.equal(validCommandName('tool\0next'), false);
});

test('inaccessible earlier Windows directories prevent an unearned confirmed selection', async () => {
  const fs = windowsFixture(['C:\\Later\\node.exe'], { denied: ['C:\\Private'] });
  const result = await inspectCommands(['node'], environment('C:\\work', 'C:\\Private;C:\\Later', { platform: 'win32', fs }));
  assert.equal(result.commands[0].selected, null);
  assert.equal(result.commands[0].observedFirst, 'C:\\Later\\node.exe');
  assert.equal(result.commands[0].complete, false);
  assert(result.checks.some((finding) => finding.id === 'which.incomplete'));
  assert(!result.checks.some((finding) => finding.id === 'which.missing'));
});

test('an inaccessible directory after selection does not invalidate the preceding selected candidate', async () => {
  const fs = windowsFixture(['C:\\First\\node.exe'], { denied: ['C:\\Private'] });
  const result = await inspectCommands(['node'], environment('C:\\work', 'C:\\First;C:\\Private', { platform: 'win32', fs }));
  assert.equal(result.commands[0].selected, 'C:\\First\\node.exe');
  assert.equal(result.commands[0].complete, false);
  assert.match(result.commands[0].note, /precedes/);
});

test('directory enumeration limits are bounded and mark selection incomplete', async () => {
  let reads = 0;
  const fs = windowsFixture(['C:\\Huge\\node.exe'], { directoryEntries: () => ({
    async read() { reads += 1; return { name: reads === 1 ? 'node.exe' : `file-${reads}.txt` }; }, async close() {},
  }) });
  const result = await inspectCommands(['node'], environment('C:\\work', 'C:\\Huge', { platform: 'win32', pathExt: '.EXE', fs }));
  assert.equal(reads, 8192);
  assert.equal(result.commands[0].selected, null);
  assert.equal(result.commands[0].observedFirst, 'C:\\Huge\\node.exe');
  assert.equal(result.truncated, true);
});

test('PATH and command count bounds produce explicit incomplete reports with unique finding IDs', async () => {
  const fs = windowsFixture([]);
  const env = environment('C:\\work', Array.from({ length: 257 }, (_value, index) => `C:\\missing-${index}`).join(';'), { platform: 'win32', fs });
  const paths = await inspectPath(env);
  assert.equal(paths.entries.length, 256);
  assert.equal(paths.truncated, true);
  assert(paths.checks.some((finding) => finding.id === 'path.incomplete'));
  const result = await inspectCommands(Array.from({ length: 33 }, (_value, index) => `tool-${index}`), env);
  assert.equal(result.commands.length, 32);
  assert.equal(result.truncated, true);
  assert(result.commands.every((command) => !command.complete));
  assert.equal(new Set(result.checks.map((finding) => finding.id)).size, result.checks.length);
});

test('character-bound PATH parsing never interprets a cut-off directory prefix', () => {
  const prefix = '/first:';
  const value = `${prefix}${'x'.repeat(128 * 1024)}:/last`;
  assert.deepEqual(parsePathEntries(value, 'linux', '/cwd').map((entry) => entry.path), ['/first']);
});

test('unset PATH produces no implicit lookup and is explained', async () => {
  const env = environment('C:\\work', '', { platform: 'win32', pathDefined: false, fs: windowsFixture(['C:\\work\\node.exe']) });
  assert.equal((await inspectCommands(['node'], env)).commands[0].selected, null);
  const paths = await inspectPath(env);
  assert.equal(paths.entries.length, 0);
  assert.equal(paths.checks[0].id, 'path.unset');
});

test('a never-resolving PATH stat times out and no further filesystem calls are started', async () => {
  let calls = 0;
  const env = environment('C:\\work', 'C:\\Disconnected;C:\\Later', { platform: 'win32',
    fs: { stat() { calls += 1; return new Promise(() => {}); } } });
  const start = performance.now();
  const result = await inspectPath(env, { timeoutMs: 25, operationTimeoutMs: 25 });
  assert(performance.now() - start < 1000);
  assert.equal(calls, 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.truncated, true);
  assert(result.entries.every((entry) => entry.exists === null));
  assert(result.checks.some((finding) => finding.id === 'path.incomplete'));
  assert(!result.checks.some((finding) => finding.id === 'path.clean'));
});

test('a never-resolving command lstat produces an incomplete lookup instead of a missing verdict', async () => {
  let calls = 0;
  const env = environment('/work', '/disconnected:/later', { fs: { lstat() { calls += 1; return new Promise(() => {}); } } });
  const result = await inspectCommands(['node'], env, { timeoutMs: 25, operationTimeoutMs: 25 });
  assert.equal(calls, 1);
  assert.equal(result.timedOut, true);
  assert.equal(result.commands[0].complete, false);
  assert.equal(result.commands[0].selected, null);
  assert(!result.checks.some((finding) => finding.id === 'which.missing'));
});

test('a Windows opendir arriving after the deadline is closed without scanning it', async () => {
  let resolveOpen;
  let closed = false;
  let reads = 0;
  const env = environment('C:\\work', 'C:\\Disconnected', { platform: 'win32',
    fs: { opendir: () => new Promise((resolve) => { resolveOpen = resolve; }) } });
  const result = await inspectCommands(['node'], env, { timeoutMs: 25, operationTimeoutMs: 25 });
  assert.equal(result.timedOut, true);
  resolveOpen({ async read() { reads += 1; return null; }, async close() { closed = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
  assert.equal(reads, 0);
});

test('a never-resolving directory read reaches the budget and closes its handle', async () => {
  let reads = 0;
  let closed = false;
  const env = environment('C:\\work', 'C:\\Disconnected', { platform: 'win32', fs: {
    async opendir() { return { read() { reads += 1; return new Promise(() => {}); }, async close() { closed = true; } }; },
  } });
  const result = await inspectCommands(['node'], env, { timeoutMs: 25, operationTimeoutMs: 25 });
  assert.equal(result.timedOut, true);
  assert.equal(reads, 1);
  assert.equal(closed, true);
});
