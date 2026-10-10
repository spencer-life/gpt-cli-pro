import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { stat } from 'node:fs/promises';
import path from 'node:path';
import { safeEnvironment, systemCandidates, runSystem, runBounded, readWindowsRoot } from '../src/process.mjs';

const windowsOptions = { nativeRealpath: () => 'D:\\Windows' };
const pollutedWindowsEnvironment = {
  SystemRoot: 'E:\\untrusted', SYSTEMROOT: 'F:\\also-untrusted', windir: 'G:\\untrusted',
  ProgramFiles: 'H:\\untrusted', 'ProgramFiles(x86)': 'I:\\untrusted', ProgramW6432: 'J:\\untrusted',
  LOCALAPPDATA: 'K:\\untrusted', APPDATA: 'L:\\untrusted', Path: 'M:\\untrusted',
  PSModulePath: 'N:\\untrusted', SystemDrive: 'O:', NODE_OPTIONS: '--require untrusted', TOKEN: 'secret',
};

function childFixture(stdout = '', delay = 0, code = 0) {
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  const finish = () => { child.stdout.end(stdout); child.stderr.end(); child.emit('close', code); };
  const timer = delay ? setTimeout(finish, delay) : null;
  if (!timer) queueMicrotask(finish);
  child.kill = () => { clearTimeout(timer); };
  child.unref = () => {};
  return child;
}

test('subprocess environment excludes credentials and execution overrides', () => {
  const env = safeEnvironment({ HOME: '/home/ada', PATH: '/untrusted', TOKEN: 'secret', NODE_OPTIONS: '--require evil',
    GIT_CONFIG_COUNT: '2', GIT_DIR: '/evil', LD_PRELOAD: '/evil.so', LANG: 'secret', PSModulePath: '/evil' }, 'linux');
  assert.equal(env.HOME, '/home/ada');
  assert.equal(env.TOKEN, undefined);
  assert.equal(env.NODE_OPTIONS, undefined);
  assert.equal(env.LD_PRELOAD, undefined);
  assert.equal(env.GIT_CONFIG_COUNT, undefined);
  assert.equal(env.GIT_DIR, undefined);
  assert.equal(env.GIT_OPTIONAL_LOCKS, '0');
  assert.equal(env.GIT_CONFIG_GLOBAL, '/dev/null');
  assert.equal(env.PATH, '/usr/bin:/bin:/usr/sbin:/sbin');
});

test('Windows helper paths and child system variables ignore all inherited install roots', () => {
  assert.deepEqual(systemCandidates('powershell.exe', 'win32', pollutedWindowsEnvironment, windowsOptions),
    ['D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
  assert.deepEqual(systemCandidates('netstat', 'win32', pollutedWindowsEnvironment, windowsOptions),
    ['D:\\Windows\\System32\\netstat.exe']);
  assert.deepEqual(systemCandidates('git', 'win32', pollutedWindowsEnvironment, windowsOptions), []);
  assert.deepEqual(systemCandidates('git', 'win32', pollutedWindowsEnvironment,
    { ...windowsOptions, knownFolders: ['P:\\Managed Apps'] }),
  ['P:\\Managed Apps\\Git\\cmd\\git.exe', 'P:\\Managed Apps\\Git\\bin\\git.exe']);
  const clean = safeEnvironment(pollutedWindowsEnvironment, 'win32', windowsOptions);
  assert.equal(clean.SystemRoot, 'D:\\Windows');
  assert.equal(clean.WINDIR, 'D:\\Windows');
  assert.equal(clean.SystemDrive, 'D:');
  assert.equal(clean.PATH, 'D:\\Windows\\System32;D:\\Windows');
  assert.equal(clean.PSModulePath, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.equal(clean.GIT_CONFIG_GLOBAL, 'NUL');
  for (const key of Object.keys(pollutedWindowsEnvironment)) {
    if (!['SystemRoot', 'SystemDrive', 'PSModulePath'].includes(key)) assert.equal(clean[key], undefined, key);
  }
  assert.ok(Object.values(clean).every(value => !value.includes('untrusted') && value !== 'secret'));
  assert.deepEqual(systemCandidates('node', 'linux'), []);
});

test('the fixed OS namespace resolves a canonical non-C Windows directory without report generation', () => {
  let calls = 0;
  assert.equal(readWindowsRoot(value => {
    calls += 1;
    assert.equal(value, '\\\\?\\GLOBALROOT\\SystemRoot');
    return 'z:\\WinNT';
  }), 'Z:\\WinNT');
  assert.equal(calls, 1);
});

test('unavailable, malformed, non-local, or ambiguous native roots fail closed', () => {
  const invalid = [
    null, {}, [], '', 'D:\\', 'Windows', 'D:Windows', '\\\\server\\share\\Windows',
    '\\\\?\\D:\\Windows', 'D:\\Windows\\..\\untrusted', 'D:\\Windows.', 'D:\\Windows ',
    'D:\\Windows\u0000', 'D:\\Windows;E:\\untrusted', `D:\\${'x'.repeat(32768)}`,
  ];
  for (const root of invalid) {
    const options = { nativeRealpath: () => root };
    assert.equal(readWindowsRoot(options.nativeRealpath), null);
    assert.deepEqual(systemCandidates('powershell', 'win32', pollutedWindowsEnvironment, options), []);
    assert.throws(() => safeEnvironment(pollutedWindowsEnvironment, 'win32', options),
      { code: 'TRUSTED_WINDOWS_ROOT_UNAVAILABLE' });
  }
});

test('native namespace lookup failures remain generic and never use inherited root fallbacks', () => {
  const nativeRealpath = () => { throw new Error('Sensitive filesystem failure detail'); };
  assert.equal(readWindowsRoot(nativeRealpath), null);
  assert.deepEqual(systemCandidates('netstat', 'win32', pollutedWindowsEnvironment, { nativeRealpath }), []);
});

test('runSystem uses the same native anchor for executed helpers and their sanitized child environment', async () => {
  const executed = [];
  const examined = [];
  const fixtureOptions = {
    ...windowsOptions, platform: 'win32', env: pollutedWindowsEnvironment, cwd: 'M:\\untrusted-project',
    fs: {
      async stat(file) { examined.push(file); return { isFile: () => true }; },
      async access() {},
    },
    spawn(executable, args, options) {
      executed.push({ executable, args, options });
      return childFixture(args.at(-1).includes('GetFolderPath') ? 'P:\\Managed Apps\u0000Q:\\Programs' : '');
    },
  };
  for (const name of ['powershell', 'netstat', 'git']) {
    assert.equal((await runSystem(name, ['literal argument'], fixtureOptions)).ok, true);
  }
  assert.deepEqual(examined, [
    'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
    'D:\\Windows\\System32\\netstat.exe', 'P:\\Managed Apps\\Git\\cmd\\git.exe',
  ]);
  assert.deepEqual(executed.filter(call => !call.args.at(-1).includes('GetFolderPath')).map(call => call.executable), examined);
  for (const call of executed) {
    assert.equal(call.options.env.SystemRoot, 'D:\\Windows');
    assert.equal(call.options.env.PSModulePath, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
    assert.equal(call.options.shell, false);
    assert.equal(call.options.env.NODE_OPTIONS, undefined);
    assert.equal(call.options.env.TOKEN, undefined);
    if (!call.args.at(-1).includes('GetFolderPath')) assert.equal(call.args.at(-1), 'literal argument');
  }
  const bootstrap = executed.find(call => call.args.at(-1).includes('GetFolderPath'));
  assert.equal(bootstrap.options.cwd, 'D:\\Windows');
  assert.deepEqual(bootstrap.args.slice(0, -1), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.match(bootstrap.args.at(-1), /SpecialFolderOption\]::DoNotVerify/u);
  assert.match(bootstrap.args.at(-1), /SpecialFolder\]::ProgramFilesX86/u);
  assert.match(bootstrap.args.at(-1), /\$env:PSModulePath = \$PSHOME/u);
  assert.doesNotMatch(bootstrap.args.at(-1), /untrusted|\$env:(?:ProgramFiles|SystemRoot)|LOCALAPPDATA/u);
  assert.deepEqual(executed.at(-1).args.slice(0, -1), ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
    '-c', 'core.hooksPath=NUL']);
});

test('runSystem does not stat or launch inherited Windows paths when the anchor is unavailable', async () => {
  const result = await runSystem('powershell', [], {
    platform: 'win32', env: pollutedWindowsEnvironment, nativeRealpath: () => null,
    fs: { stat() { assert.fail('No filesystem lookup is permitted without an anchor.'); } },
    spawn() { assert.fail('No helper may execute without an anchor.'); },
  });
  assert.deepEqual(result, { ok: false, stdout: '', stderr: '', code: null,
    unavailable: true, error: 'TRUSTED_TOOL_NOT_FOUND' });
});

test('failed, malformed, remote, or oversized known-folder output cannot select Git', async () => {
  const responses = [
    { stdout: 'P:\\Managed Apps\u0000Q:\\Programs', code: 1 },
    { stdout: 'P:\\Managed Apps' }, { stdout: 'P:\\Managed Apps\u0000Q:\\Programs\u0000extra' },
    { stdout: 'relative\u0000Q:\\Programs' }, { stdout: '\\\\server\\share\u0000Q:\\Programs' },
    { stdout: '\u0000' }, { stdout: 'x'.repeat(5000) },
  ];
  for (const response of responses) {
    const executables = [];
    const result = await runSystem('git', ['status'], {
      ...windowsOptions, platform: 'win32', env: pollutedWindowsEnvironment,
      knownFolders: ['E:\\untrusted'],
      fs: { stat() { assert.fail('Unvalidated known-folder output must not reach filesystem lookup.'); } },
      spawn(executable) {
        executables.push(executable);
        return childFixture(response.stdout, 0, response.code ?? 0);
      },
    });
    assert.deepEqual(executables, ['D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
    assert.equal(result.unavailable, true);
    assert.equal(result.error, 'TRUSTED_TOOL_NOT_FOUND');
    assert.equal(result.stdout, '');
    assert.equal(result.stderr, '');
  }
});

test('known-folder results are deduplicated and injected lookups never contaminate later calls', async () => {
  for (const root of ['P:\\Managed Apps', 'Q:\\Other Apps']) {
    const examined = [];
    const result = await runSystem('git', [], {
      ...windowsOptions, platform: 'win32', env: pollutedWindowsEnvironment,
      fs: { async stat(file) { examined.push(file); return { isFile: () => false }; } },
      spawn() { return childFixture(`${root}\u0000${root.toLowerCase()}`); },
    });
    assert.equal(result.unavailable, true);
    assert.deepEqual(examined, [`${root}\\Git\\cmd\\git.exe`, `${root}\\Git\\bin\\git.exe`]);
  }
});

test('the known-folder bootstrap spends the Git call deadline instead of extending it', async () => {
  let launches = 0;
  const start = performance.now();
  const result = await runSystem('git', [], {
    ...windowsOptions, platform: 'win32', timeoutMs: 600,
    fs: { async stat() { return { isFile: () => true }; }, async access() {} },
    spawn() {
      launches += 1;
      return launches === 1 ? childFixture('P:\\Managed Apps\u0000', 400) : childFixture('', 2000);
    },
  });
  assert.equal(launches, 2);
  assert.equal(result.error, 'TIMEOUT');
  assert.ok(performance.now() - start < 900, 'Bootstrap and Git must share one deadline.');
});

test('a hanging helper stat uses the same deadline and does not start another lookup or process', async () => {
  let examined = 0;
  const result = await runSystem('netstat', [], {
    ...windowsOptions, platform: 'win32', timeoutMs: 30,
    fs: { stat() { examined += 1; return new Promise(() => {}); } },
    spawn() { assert.fail('A timed-out filesystem lookup must not launch a helper.'); },
  });
  assert.equal(result.error, 'TIMEOUT');
  assert.equal(examined, 1);
});

test('native Windows helper paths and Git metadata remain usable with polluted environment roots', {
  skip: process.platform !== 'win32',
}, async (t) => {
  const root = readWindowsRoot();
  assert.equal(typeof root, 'string', 'Native Windows must resolve the fixed system-directory alias.');
  assert.deepEqual(systemCandidates('netstat', 'win32', pollutedWindowsEnvironment), [`${root}\\System32\\netstat.exe`]);
  const clean = safeEnvironment(pollutedWindowsEnvironment, 'win32');
  assert.equal(clean.SystemRoot, root);
  assert.equal(clean.PSModulePath, `${root}\\System32\\WindowsPowerShell\\v1.0\\Modules`);
  const observed = await runSystem('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$env:PSModulePath = $PSHOME + '\\Modules'; "
    + '[Console]::Write($env:SystemRoot); [Console]::Write([char]0); [Console]::Write($env:PSModulePath)'],
  { env: pollutedWindowsEnvironment, timeoutMs: 10000 });
  assert.equal(observed.ok, true, observed.error);
  const observedFields = observed.stdout.split('\u0000');
  assert.equal(observedFields.length, 2);
  assert.equal(observedFields[0], root);
  assert.equal(observedFields[1].toLowerCase(), `${root}\\System32\\WindowsPowerShell\\v1.0\\Modules`.toLowerCase());
  assert.ok(!observed.stdout.includes('untrusted'));
  const folders = await runSystem('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "$env:PSModulePath = $PSHOME + '\\Modules'; "
    + '[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles, [Environment+SpecialFolderOption]::DoNotVerify)); '
    + '[Console]::Write([char]0); '
    + '[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86, [Environment+SpecialFolderOption]::DoNotVerify))'],
  { env: pollutedWindowsEnvironment, timeoutMs: 10000 });
  assert.equal(folders.ok, true, folders.error);
  assert.ok(!folders.stdout.includes('untrusted'));
  let installed = false;
  for (const folder of folders.stdout.split('\u0000').filter(Boolean)) {
    for (const subdirectory of ['cmd', 'bin']) {
      try { installed ||= (await stat(path.win32.join(folder, 'Git', subdirectory, 'git.exe'))).isFile(); }
      catch (error) { if (!['ENOENT', 'ENOTDIR'].includes(error.code)) throw error; }
    }
  }
  if (installed) {
    const metadata = await runSystem('git', ['rev-parse', '--is-inside-work-tree'], {
      env: pollutedWindowsEnvironment, cwd: new URL('..', import.meta.url), timeoutMs: 2000,
    });
    assert.equal(metadata.ok, true, metadata.error);
    assert.equal(metadata.stdout.trim(), 'true');
  } else t.diagnostic('No Git executable in the verified Program Files locations; metadata assertion is not applicable.');
});

test('unsupported system command cannot use PATH or a shell', async () => {
  const result = await runSystem('arbitrary; command', []);
  assert.equal(result.unavailable, true);
  assert.equal(result.error, 'TRUSTED_TOOL_NOT_FOUND');
});

test('bounded process passes shell metacharacters literally', async () => {
  const value = '$(whoami); & < > `touch no`';
  const result = await runBounded(process.execPath, ['-e', 'process.stdout.write(process.argv[1])', value]);
  assert.equal(result.ok, true);
  assert.equal(result.stdout, value);
});

test('timeouts and output caps terminate hanging or noisy subprocesses', async () => {
  const start = Date.now();
  const hang = await runBounded(process.execPath, ['-e', 'setInterval(() => {}, 10000)'], { timeoutMs: 100 });
  assert.equal(hang.error, 'TIMEOUT');
  assert.ok(Date.now() - start < 5000);
  const noisy = await runBounded(process.execPath, ['-e', 'process.stdout.write("x".repeat(100000))'], { maxBuffer: 1000 });
  assert.equal(noisy.error, 'OUTPUT_LIMIT');
  assert.ok(noisy.stdout.length <= 1000);
});

test('missing executable is an unavailable result without throwing', async () => {
  const result = await runBounded(process.platform === 'win32' ? 'C:\\wslens-missing-tool.exe' : '/wslens-no-such-tool', []);
  assert.equal(result.ok, false);
  assert.equal(result.unavailable, true);
});
