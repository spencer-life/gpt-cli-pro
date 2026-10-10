import test from 'node:test';
import assert from 'node:assert/strict';
import { collectEnvironment, detectWSL, parseMountInfo, findMountForPath, classifyFilesystem, environmentChecks, createIoBudget } from '../src/environment.mjs';

const MOUNTS = [
  '28 1 8:1 / / rw,relatime - ext4 /dev/sdc rw',
  '29 28 0:57 / /mnt/c rw,noatime - 9p C:\\134 rw,aname=drvfs;path=C:\\134;uid=1000',
  '30 28 0:58 / /drives/My\\040Drive rw - drvfs D:\\134 rw',
  '31 29 8:2 / /mnt/c/native rw - ext4 /dev/sdd rw',
  '32 28 0:59 / /mnt/share rw - nfs4 server:/share rw',
].join('\n');

test('detects WSL versions using kernel evidence without guessing from environment markers', () => {
  assert.deepEqual(detectWSL('linux', '5.15.167.4-microsoft-standard-WSL2', {}), { isWSL: true, wslVersion: 2 });
  assert.deepEqual(detectWSL('linux', '4.4.0-19041-Microsoft', {}), { isWSL: true, wslVersion: 1 });
  assert.deepEqual(detectWSL('linux', '6.1.0-custom', { WSL_DISTRO_NAME: 'Ubuntu' }), { isWSL: true, wslVersion: null });
  assert.deepEqual(detectWSL('linux', '6.1.0-custom', { WSL_INTEROP: '/run/WSL/123_interop' }), { isWSL: true, wslVersion: null });
  assert.deepEqual(detectWSL('linux', '6.1.0-custom-Microsoft', {}), { isWSL: true, wslVersion: null });
  assert.deepEqual(detectWSL('win32', '10.0.26100', { WSL_DISTRO_NAME: 'Ubuntu' }), { isWSL: false, wslVersion: null });
  assert.deepEqual(detectWSL('linux', '6.8.0-generic', { WSLENV: 'PATH/l' }), { isWSL: false, wslVersion: null });
});

test('mount parser decodes kernel escapes and the longest component-boundary match wins', () => {
  const mounts = parseMountInfo(MOUNTS);
  assert.equal(mounts.length, 5);
  assert.equal(mounts[1].source, 'C:\\');
  assert.equal(mounts[2].mountPoint, '/drives/My Drive');
  assert.equal(findMountForPath('/mnt/c/Users/project', mounts).id, 29);
  assert.equal(findMountForPath('/mnt/c/native/project', mounts).id, 31);
  assert.equal(findMountForPath('/mnt/code/project', mounts).id, 28);
  assert.equal(findMountForPath('/mnt/c/../share/project', mounts).id, 32);
  assert.equal(findMountForPath('/mnt/c', mounts).id, 29);
  assert.equal(findMountForPath('relative', mounts), null);
});

test('mount parser rejects malformed lines and honors entry limits', () => {
  const invalid = ['bad data', '1 2 - ext4 /dev/sda rw', 'x 2 0:1 / /mnt rw - ext4 /dev/sda rw'];
  assert.deepEqual(parseMountInfo(invalid.join('\n')), []);
  assert.equal(parseMountInfo(MOUNTS, { maxEntries: 2 }).length, 2);
  assert.equal(parseMountInfo(MOUNTS, { maxEntries: 0 }).length, 0);
});

test('mount metadata overrides conventional drive paths and identifies custom automount roots', () => {
  const environment = { platform: 'linux', isWSL: true, mounts: parseMountInfo(MOUNTS) };
  assert.equal(classifyFilesystem('/mnt/c/project', environment).kind, 'windows');
  assert.equal(classifyFilesystem('/mnt/c/project', environment).confidence, 'confirmed');
  assert.equal(classifyFilesystem('/mnt/c/native/project', environment).kind, 'linux');
  assert.equal(classifyFilesystem('/drives/My Drive/project', environment).kind, 'windows');
  assert.equal(classifyFilesystem('/mnt/share/project', environment).kind, 'network');
  assert.equal(classifyFilesystem('/home/me/project', environment).kind, 'linux');
  assert.equal(classifyFilesystem('/mnt/c/project', { ...environment, mounts: [] }).confidence, 'inferred');
  assert.equal(classifyFilesystem('/mnt/custom/project', { ...environment, mounts: [] }).kind, 'unknown');
  assert.equal(classifyFilesystem('/mnt/c/project', { platform: 'linux', isWSL: false, mounts: [] }).kind, 'unknown');
});

test('generic 9p mounts are not mislabeled as Windows drive mounts', () => {
  const mounts = parseMountInfo('1 0 0:1 / / rw - 9p linux-share rw,trans=virtio');
  assert.equal(classifyFilesystem('/project', { platform: 'linux', isWSL: true, mounts }).kind, 'network');
});

test('Windows WSL share and ordinary UNC paths remain distinct', () => {
  const environment = { platform: 'win32' };
  assert.equal(classifyFilesystem('\\\\wsl.localhost\\Ubuntu\\home\\me', environment).kind, 'linux');
  assert.equal(classifyFilesystem('\\\\WSL$\\Ubuntu\\home\\me', environment).kind, 'linux');
  assert.equal(classifyFilesystem('\\\\server\\share\\project', environment).kind, 'network');
  assert.equal(classifyFilesystem('C:\\project', environment).kind, 'windows');
});

test('environment collection accepts deterministic overrides and never returns arbitrary environment variables', async () => {
  const environment = await collectEnvironment({ platform: 'linux', arch: 'x64', release: '5.15.0-microsoft-standard-WSL2',
    cwd: '/mnt/c/Project', cwdRealPath: '/mnt/c/Project', mountInfo: MOUNTS,
    env: { HOME: '/home/flint', PATH: '/usr/bin:/mnt/c/bin', WSL_DISTRO_NAME: 'Ubuntu', API_SECRET: 'never-return-this' } });
  assert.equal(environment.cwd, '/mnt/c/Project');
  assert.equal(environment.home, '/home/flint');
  assert.equal(environment.isWSL, true);
  assert.equal(environment.wslVersion, 2);
  assert.equal(environment.distro, 'Ubuntu');
  assert.equal(environment.pathValue, '/usr/bin:/mnt/c/bin');
  assert.equal(environment.mountInfoStatus, 'ok');
  assert.equal(environment.mountInfoTruncated, false);
  assert.equal(JSON.stringify(environment).includes('never-return-this'), false);
  assert.equal(Object.hasOwn(environment, 'env'), false);
  const checks = environmentChecks(environment);
  assert.equal(checks.find((finding) => finding.id === 'environment.windows-filesystem').status, 'warn');
  assert(checks.find((finding) => finding.id === 'environment.windows-filesystem').remedy.includes('\\\\wsl.localhost\\<distro>'));
  assert.equal(new Set(checks.map((finding) => finding.id)).size, checks.length);
});

test('Windows environment names are case insensitive and do not inherit fake WSL markers', async () => {
  const environment = await collectEnvironment({ platform: 'win32', arch: 'arm64', release: '10.0.26100', cwd: 'C:\\project',
    env: { Path: 'C:\\Tools;C:\\Windows', Pathext: '.EXE;.CMD', UserProfile: 'C:\\Users\\Dev', WSL_DISTRO_NAME: 'Ubuntu' } });
  assert.equal(environment.pathValue, 'C:\\Tools;C:\\Windows');
  assert.equal(environment.pathExt, '.EXE;.CMD');
  assert.equal(environment.home, 'C:\\Users\\Dev');
  assert.equal(environment.isWSL, false);
  assert.equal(environment.distro, null);
  assert.equal(environment.mountInfoStatus, 'unsupported');
});

test('missing PATH is distinguishable from explicitly empty PATH', async () => {
  const options = { platform: 'linux', release: '6.8.0', cwd: '/project', mountInfo: '', home: '/home/dev' };
  assert.equal((await collectEnvironment({ ...options, env: {} })).pathDefined, false);
  assert.equal((await collectEnvironment({ ...options, env: { PATH: '' } })).pathDefined, true);
});

test('unknown or truncated mount inspection never produces a Linux filesystem pass', async () => {
  const base = { platform: 'linux', arch: 'x64', release: 'custom', isWSL: true, wslVersion: null, cwd: '/project', mounts: [] };
  assert.equal(environmentChecks(base).find((finding) => finding.id === 'environment.filesystem-unknown').status, 'skip');
  const large = await collectEnvironment({ platform: 'linux', release: 'microsoft-standard-WSL2', cwd: '/project', cwdRealPath: '/project', env: {},
    mountInfo: `${MOUNTS}\n${'1 0 8:1 / /extra rw - ext4 /dev/sda rw\n'.repeat(4100)}` });
  assert.equal(large.mountInfoTruncated, true);
  const checks = environmentChecks(large);
  assert(checks.some((finding) => finding.id === 'environment.mounts-incomplete'));
  assert(!checks.some((finding) => finding.id === 'environment.linux-filesystem'));
});

test('lexical cwd and real cwd can report a symlink crossing the filesystem boundary', () => {
  const checks = environmentChecks({ platform: 'linux', arch: 'x64', release: 'WSL2', isWSL: true, wslVersion: 2,
    cwd: '/home/dev/project-link', cwdRealPath: '/mnt/c/project', mounts: parseMountInfo(MOUNTS) });
  assert(checks.some((finding) => finding.id === 'environment.windows-filesystem'));
});

test('a mount read that never returns reaches its deadline without spawning another filesystem operation', async () => {
  let opens = 0;
  let realpaths = 0;
  const start = performance.now();
  const environment = await collectEnvironment({ platform: 'linux', release: 'WSL2', cwd: '/project', env: {},
    timeoutMs: 25, operationTimeoutMs: 25,
    fs: { open() { opens += 1; return new Promise(() => {}); }, realpath() { realpaths += 1; return new Promise(() => {}); } } });
  assert(performance.now() - start < 1000);
  assert.equal(opens, 1);
  assert.equal(realpaths, 0);
  assert.equal(environment.mountInfoStatus, 'timeout');
  assert.equal(environment.environmentScanIncomplete, true);
  assert(environmentChecks(environment).some((finding) => finding.id === 'environment.incomplete'));
});

test('a stalled cwd realpath cannot yield an assured filesystem classification', async () => {
  const environment = await collectEnvironment({ platform: process.platform, release: 'WSL2', cwd: '/project', env: {}, mountInfo: MOUNTS,
    timeoutMs: 25, operationTimeoutMs: 25, fs: { realpath: () => new Promise(() => {}) } });
  assert.equal(environment.cwdRealPathResolved, false);
  assert.equal(environment.environmentScanIncomplete, true);
  assert(!environmentChecks(environment).some((finding) => finding.id === 'environment.linux-filesystem'));
});

test('a timed-out filesystem handle is cleaned up if it arrives later', async () => {
  let resolveOperation;
  let closed = false;
  const budget = createIoBudget({ timeoutMs: 20, operationTimeoutMs: 20 });
  const operation = budget.run(() => new Promise((resolve) => { resolveOperation = resolve; }), (handle) => handle.close());
  await assert.rejects(operation, { code: 'ETIMEDOUT' });
  assert.equal(budget.expired, true);
  resolveOperation({ async close() { closed = true; } });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(closed, true);
});
