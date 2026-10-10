import { open, realpath } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const MAX_MOUNT_BYTES = 512 * 1024;
const MAX_MOUNTS = 4096;
const FILESYSTEM_DOCS = 'https://learn.microsoft.com/en-us/windows/wsl/filesystems';

/** Bound non-cancelable filesystem calls; late handles are closed by the caller. */
export function createIoBudget({ timeoutMs = 5000, operationTimeoutMs = 1000 } = {}) {
  const total = Number.isFinite(timeoutMs) ? Math.max(1, Math.min(timeoutMs, 30000)) : 5000;
  const perOperation = Number.isFinite(operationTimeoutMs) ? Math.max(1, Math.min(operationTimeoutMs, total)) : Math.min(1000, total);
  const deadline = performance.now() + total;
  let timeouts = 0;
  let deadlineReached = false;
  const timeoutError = () => Object.assign(new Error('Filesystem inspection timed out'), { code: 'ETIMEDOUT' });
  return {
    get expired() { return deadlineReached || performance.now() >= deadline; },
    get timeouts() { return timeouts; },
    async run(operation, onLateResult) {
      const remaining = deadline - performance.now();
      if (deadlineReached || remaining <= 0) throw timeoutError();
      return new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
          timedOut = true;
          timeouts += 1;
          if (remaining <= perOperation) deadlineReached = true;
          reject(timeoutError());
        }, Math.min(perOperation, remaining));
        Promise.resolve().then(operation).then((result) => {
          clearTimeout(timer);
          if (timedOut) {
            if (onLateResult) Promise.resolve().then(() => onLateResult(result)).catch(() => {});
          } else resolve(result);
        }, (error) => {
          clearTimeout(timer);
          if (!timedOut) reject(error);
        });
      });
    },
  };
}

function envValue(env, key, platform) {
  if (platform !== 'win32') return typeof env[key] === 'string' ? env[key] : undefined;
  const found = Object.keys(env).find((name) => name.toUpperCase() === key);
  return found && typeof env[found] === 'string' ? env[found] : undefined;
}

/** Environment markers establish WSL presence, but do not establish its version. */
export function detectWSL(platform, release, env = {}) {
  if (platform !== 'linux') return { isWSL: false, wslVersion: null };
  const kernel = String(release ?? '');
  const isWSL = /microsoft|wsl2/i.test(kernel)
    || Boolean(env.WSL_DISTRO_NAME || env.WSL_INTEROP);
  let wslVersion = null;
  if (isWSL && /(?:microsoft-standard|wsl2)/i.test(kernel)) wslVersion = 2;
  // Legacy WSL 1 reports this specific release shape. A custom Microsoft kernel
  // without a version marker stays unknown instead of being guessed as WSL 1.
  else if (isWSL && /^\d+\.\d+\.\d+(?:-\d+)?-Microsoft$/i.test(kernel)) wslVersion = 1;
  return { isWSL, wslVersion };
}

function unescapeMountField(value) {
  return value.replace(/\\([0-7]{3})/g, (_match, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Parse Linux mountinfo without depending on a shell or a fixed automount root. */
export function parseMountInfo(text, { maxEntries = MAX_MOUNTS } = {}) {
  const mounts = [];
  const limit = Math.max(0, Math.min(MAX_MOUNTS, Math.trunc(maxEntries)));
  for (const line of String(text ?? '').slice(0, MAX_MOUNT_BYTES).split('\n')) {
    if (mounts.length >= limit) break;
    const separator = line.indexOf(' - ');
    if (separator < 0) continue;
    const before = line.slice(0, separator).split(' ');
    const after = line.slice(separator + 3).split(' ');
    if (before.length < 6 || after.length < 3 || !/^\d+$/.test(before[0])) continue;
    const mountPoint = unescapeMountField(before[4]);
    if (!mountPoint.startsWith('/')) continue;
    mounts.push({
      id: Number(before[0]),
      parentId: Number(before[1]),
      root: unescapeMountField(before[3]),
      mountPoint: path.posix.normalize(mountPoint),
      options: before[5].split(',').map(unescapeMountField),
      fsType: after[0],
      source: unescapeMountField(after[1]),
      superOptions: after[2].split(',').map(unescapeMountField),
    });
  }
  return mounts;
}

/** Component-aware longest mount match; a /mnt/c mount never matches /mnt/code. */
export function findMountForPath(filePath, mounts = []) {
  if (typeof filePath !== 'string' || !path.posix.isAbsolute(filePath)) return null;
  const target = path.posix.normalize(filePath);
  let selected = null;
  let selectedLength = -1;
  for (const mount of mounts) {
    const value = mount?.mountPoint ?? mount?.mountpoint;
    if (typeof value !== 'string' || !value.startsWith('/')) continue;
    const point = path.posix.normalize(value).replace(/\/$/, '') || '/';
    const matches = point === '/' || target === point || target.startsWith(`${point}/`);
    if (matches && point.length >= selectedLength) {
      selected = mount;
      selectedLength = point.length;
    }
  }
  return selected;
}

/** Classify observed mount metadata first; conventional path guesses stay explicit. */
export function classifyFilesystem(filePath, environment = {}) {
  const platform = environment.platform ?? process.platform;
  if (platform === 'win32') {
    if (/^\\\\wsl(?:\.localhost|\$)\\/i.test(filePath ?? '')) {
      return { kind: 'linux', source: 'path', confidence: 'inferred', filesystem: null, mount: null };
    }
    if (/^(?:\\\\|\/\/)/.test(filePath ?? '')) {
      return { kind: 'network', source: 'path', confidence: 'inferred', filesystem: null, mount: null };
    }
    return { kind: 'windows', source: 'platform', confidence: 'inferred', filesystem: null, mount: null };
  }
  const mount = findMountForPath(filePath, environment.mounts);
  if (mount) {
    const filesystem = String(mount.fsType ?? mount.type ?? '').toLowerCase();
    const options = [...(mount.options ?? []), ...(mount.superOptions ?? [])].join(',');
    const driveShare = filesystem === 'drvfs'
      || (filesystem === '9p' && (/drvfs/i.test(options) || /^[a-z]:[\\/]/i.test(mount.source ?? '')));
    let kind = 'unknown';
    if (driveShare || /^(?:ntfs3?|exfat|vfat|fuse\.ntfs.*)$/.test(filesystem)) kind = 'windows';
    else if (/^(?:ext[234]|btrfs|xfs|zfs|f2fs|overlay|tmpfs|ramfs|rootfs|lxfs|wslfs)$/.test(filesystem)) kind = 'linux';
    else if (/^(?:nfs\d*|cifs|smb\d*|9p|fuse\.sshfs)$/.test(filesystem)) kind = 'network';
    return { kind, source: 'mount', confidence: 'confirmed', filesystem, mount };
  }
  if (environment.isWSL && /^\/mnt\/[a-z](?:\/|$)/i.test(filePath ?? '')) {
    return { kind: 'windows', source: 'path', confidence: 'inferred', filesystem: null, mount: null };
  }
  return { kind: 'unknown', source: 'unavailable', confidence: 'unknown', filesystem: null, mount: null };
}

async function readMountInfo(budget, io) {
  const file = await budget.run(() => io.open('/proc/self/mountinfo', 'r'), (lateFile) => lateFile.close());
  try {
    const buffer = Buffer.alloc(MAX_MOUNT_BYTES + 1);
    let bytes = 0;
    while (bytes < buffer.length) {
      const result = await budget.run(() => file.read(buffer, bytes, buffer.length - bytes, null));
      if (result.bytesRead === 0) break;
      bytes += result.bytesRead;
    }
    return { text: buffer.subarray(0, Math.min(bytes, MAX_MOUNT_BYTES)).toString('utf8'), truncated: bytes > MAX_MOUNT_BYTES };
  } finally {
    const closing = file.close();
    closing.catch(() => {});
    if (!budget.expired) {
      try { await budget.run(() => closing); } catch { /* Cleanup must not extend the inspection deadline. */ }
    }
  }
}

export async function collectEnvironment(options = {}) {
  const budget = createIoBudget({ timeoutMs: options.timeoutMs ?? 2000, operationTimeoutMs: options.operationTimeoutMs });
  const io = { open, realpath, ...(options.fs ?? {}) };
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const release = String(options.release ?? os.release()).slice(0, 256);
  const arch = String(options.arch ?? process.arch).slice(0, 32);
  const cwd = options.cwd ?? process.cwd();
  const { isWSL, wslVersion } = detectWSL(platform, release, env);
  const home = options.home ?? envValue(env, platform === 'win32' ? 'USERPROFILE' : 'HOME', platform) ?? os.homedir();
  let mounts = [];
  let mountInfoStatus = platform === 'linux' ? 'unavailable' : 'unsupported';
  let mountInfoTruncated = false;
  if (Array.isArray(options.mounts)) {
    mounts = options.mounts.slice(0, MAX_MOUNTS);
    mountInfoTruncated = options.mounts.length > MAX_MOUNTS;
    mountInfoStatus = 'ok';
  } else if (platform === 'linux') {
    try {
      const result = options.mountInfo !== undefined
        ? { text: String(options.mountInfo), truncated: Buffer.byteLength(String(options.mountInfo)) > MAX_MOUNT_BYTES }
        : await readMountInfo(budget, io);
      mounts = parseMountInfo(result.text);
      mountInfoTruncated = result.truncated || result.text.split('\n').length > MAX_MOUNTS + 1;
      mountInfoStatus = mounts.length ? 'ok' : 'unavailable';
    } catch (error) {
      // Linux containers and restricted environments need not expose procfs.
      if (error?.code === 'ETIMEDOUT') mountInfoStatus = 'timeout';
    }
  }
  let cwdRealPath = options.cwdRealPath ?? cwd;
  let cwdRealPathResolved = options.cwdRealPath !== undefined;
  if (options.cwdRealPath === undefined && platform === process.platform) {
    try {
      cwdRealPath = await budget.run(() => io.realpath(cwd));
      cwdRealPathResolved = true;
    } catch { /* Preserve the lexical path when unavailable. */ }
  }
  const pathValue = envValue(env, 'PATH', platform);
  return {
    platform,
    arch,
    release,
    isWSL,
    wslVersion,
    distro: isWSL && typeof env.WSL_DISTRO_NAME === 'string' ? env.WSL_DISTRO_NAME.slice(0, 128) : null,
    home,
    cwd,
    cwdRealPath,
    cwdRealPathResolved,
    pathValue: pathValue ?? '',
    pathDefined: pathValue !== undefined,
    pathExt: envValue(env, 'PATHEXT', platform),
    mounts,
    mountInfoStatus,
    mountInfoTruncated,
    environmentScanIncomplete: budget.timeouts > 0 || budget.expired,
  };
}

export function environmentChecks(environment) {
  const label = environment.isWSL
    ? `WSL${environment.wslVersion ? ` ${environment.wslVersion}` : ' (version unconfirmed)'}`
    : ({ win32: 'Windows', darwin: 'macOS', linux: 'Linux' }[environment.platform] ?? environment.platform);
  const checks = [{
    id: 'environment.platform', status: 'info', title: `Inspecting ${label}`,
    detail: `This report describes the current ${environment.arch} process environment. Host and other distribution settings are not inferred.`,
    evidence: [environment.release, ...(environment.distro ? [environment.distro] : [])],
    docs: 'https://learn.microsoft.com/en-us/windows/wsl/compare-versions',
  }];
  if (environment.mountInfoTruncated) {
    checks.push({ id: 'environment.mounts-incomplete', status: 'warn', title: 'Mount metadata was truncated',
      detail: 'The mount scan reached its safety limit. Filesystem classification may not include a more specific mount.',
      remedy: 'Use the operating system mount tools to confirm the project filesystem.' });
  }
  if (environment.environmentScanIncomplete) {
    checks.push({ id: 'environment.incomplete', status: 'warn', title: 'Environment filesystem inspection timed out',
      detail: 'The filesystem I/O deadline was reached. Mount or working-directory metadata may be incomplete; pending operating-system requests cannot be canceled by Node.js.',
      remedy: 'Check disconnected drives or mounts and repeat the inspection.' });
  }
  const location = classifyFilesystem(environment.cwdRealPath ?? environment.cwd, environment);
  if (environment.isWSL && environment.cwdRealPathResolved === false) {
    checks.push({ id: 'environment.filesystem-unknown', status: 'skip', title: 'The current folder could not be resolved',
      detail: 'The real working-directory path was unavailable. Filesystem classification is skipped because a symlink could cross the Windows/WSL boundary.', evidence: [environment.cwd] });
  } else if (environment.isWSL && location.kind === 'windows') {
    checks.push({ id: 'environment.windows-filesystem', status: location.confidence === 'confirmed' ? 'warn' : 'info',
      title: location.confidence === 'confirmed' ? 'Current folder uses a Windows filesystem' : 'Current folder appears to use a Windows drive mount',
      detail: `${location.confidence === 'confirmed' ? 'Mount metadata identifies' : 'The conventional /mnt/<drive> path suggests'} a Windows filesystem. Linux package installs and file watchers can perform better inside the distribution filesystem.`,
      evidence: [environment.cwd, ...(location.filesystem ? [location.filesystem] : [])],
      remedy: 'For Linux-based development, keep the working copy under the distribution home directory. Windows can open it through \\\\wsl.localhost\\<distro>.',
      docs: FILESYSTEM_DOCS });
  } else if (environment.platform === 'win32' && location.kind === 'linux') {
    checks.push({ id: 'environment.wsl-network-path', status: 'info', title: 'Current folder is accessed through a WSL share',
      detail: 'Windows tools are accessing a Linux working copy. Keep the development runtime and its working files on the same side when filesystem performance matters.',
      evidence: [environment.cwd], docs: FILESYSTEM_DOCS });
  } else if (environment.isWSL && location.kind === 'linux' && !environment.mountInfoTruncated && !environment.environmentScanIncomplete) {
    checks.push({ id: 'environment.linux-filesystem', status: 'pass', title: 'Current folder uses a Linux filesystem',
      detail: 'The matching mount keeps Linux runtime file access within the current Linux filesystem.',
      evidence: [environment.cwd, location.filesystem], docs: FILESYSTEM_DOCS });
  } else if (environment.isWSL && location.kind === 'unknown') {
    checks.push({ id: 'environment.filesystem-unknown', status: 'skip', title: 'Current filesystem could not be classified',
      detail: 'No recognized matching mount was available. This does not establish whether the working copy crosses the Windows/WSL boundary.',
      evidence: [environment.cwd] });
  }
  return checks;
}
