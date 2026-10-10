import test from 'node:test';
import assert from 'node:assert/strict';
import { safeEnvironment, systemCandidates, runSystem, runBounded } from '../src/process.mjs';

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

test('Windows subprocesses use trusted module/system paths with case-insensitive env lookup', () => {
  const env = { SystemRoot: 'D:\\Windows', Path: 'C:\\evil', ProgramFiles: 'D:\\Program Files' };
  assert.deepEqual(systemCandidates('powershell.exe', 'win32', env), ['D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe']);
  assert.equal(safeEnvironment(env, 'win32').PSModulePath, 'D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules');
  assert.equal(safeEnvironment(env, 'win32').Path, undefined);
  assert.equal(safeEnvironment(env, 'win32').GIT_CONFIG_GLOBAL, 'NUL');
  assert.deepEqual(systemCandidates('node', 'linux'), []);
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
