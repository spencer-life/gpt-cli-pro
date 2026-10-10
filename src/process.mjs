import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants, realpathSync } from 'node:fs';
import path from 'node:path';

const POSIX_COMMANDS = {
  git: ['/usr/bin/git', '/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'],
  ss: ['/usr/bin/ss', '/bin/ss', '/usr/sbin/ss'],
  lsof: ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof'],
  netstat: ['/usr/bin/netstat', '/bin/netstat', '/usr/sbin/netstat'],
};

function localWindowsDirectory(value) {
  if (typeof value !== 'string' || value.length > 32767 || !/^[a-z]:\\/iu.test(value)
    || /[\u0000-\u001f\u007f/;]/u.test(value)) return null;
  const directory = value.endsWith('\\') ? value.slice(0, -1) : value;
  const parts = directory.slice(3).split('\\');
  if (parts.some(part => !part || part === '.' || part === '..' || /[<>:"|?*]|[. ]$/u.test(part))) return null;
  return directory[0].toUpperCase() + directory.slice(1);
}

export function readWindowsRoot(nativeRealpath = realpathSync.native) {
  try {
    // GLOBALROOT reaches the OS object-manager root, independent of the current
    // directory, drive, and inherited environment. Native realpath opens this
    // fixed OS alias and returns its canonical filesystem path. No report,
    // shell, registry script, environment dump, or directory mutation is needed.
    // https://learn.microsoft.com/windows/win32/fileio/naming-a-file#nt-namespaces
    return localWindowsDirectory(nativeRealpath('\\\\?\\GLOBALROOT\\SystemRoot'));
  } catch {
    return null;
  }
}

let cachedWindowsRoot;
function windowsRoot(options) {
  // Native I/O injection is internal to platform tests, never CLI/env input.
  if (Object.hasOwn(options, 'nativeRealpath')) return readWindowsRoot(options.nativeRealpath);
  if (process.platform !== 'win32') return null;
  if (cachedWindowsRoot === undefined) cachedWindowsRoot = readWindowsRoot();
  return cachedWindowsRoot;
}

export function systemCandidates(name, platform = process.platform, _env = process.env, options = {}) {
  const normalized = name.replace(/\.exe$/i, '').toLowerCase();
  if (platform !== 'win32') return Object.hasOwn(POSIX_COMMANDS, normalized) ? POSIX_COMMANDS[normalized] : [];
  if (!['git', 'powershell', 'netstat'].includes(normalized)) return [];
  const systemRoot = windowsRoot(options);
  if (!systemRoot) return [];
  // runSystem supplies only roots returned by the OS known-folder API. The
  // system drive is not evidence of where Program Files has been installed.
  const programFiles = (options.knownFolders ?? []).map(localWindowsDirectory).filter(Boolean);
  const candidates = {
    git: programFiles.flatMap(root => [path.win32.join(root, 'Git', 'cmd', 'git.exe'),
      path.win32.join(root, 'Git', 'bin', 'git.exe')]),
    powershell: [path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
    netstat: [path.win32.join(systemRoot, 'System32', 'netstat.exe')],
  };
  return Object.hasOwn(candidates, normalized) ? candidates[normalized] : [];
}

export function safeEnvironment(env = process.env, platform = process.platform, options = {}) {
  const allowed = new Set(['home', 'userprofile', 'temp', 'tmp', 'tmpdir']);
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    if (allowed.has(key.toLowerCase()) && typeof value === 'string') clean[key] = value;
  }
  clean.LANG = 'C';
  clean.LC_ALL = 'C';
  clean.GIT_OPTIONAL_LOCKS = '0';
  clean.GIT_TERMINAL_PROMPT = '0';
  clean.GIT_CONFIG_NOSYSTEM = '1';
  clean.GIT_CONFIG_GLOBAL = platform === 'win32' ? 'NUL' : '/dev/null';
  clean.GIT_ATTR_NOSYSTEM = '1';
  if (platform === 'win32') {
    const systemRoot = windowsRoot(options);
    if (!systemRoot) {
      const error = new Error('The Windows system location could not be established.');
      error.code = 'TRUSTED_WINDOWS_ROOT_UNAVAILABLE';
      throw error;
    }
    clean.SystemRoot = systemRoot;
    clean.WINDIR = systemRoot;
    clean.SystemDrive = path.win32.parse(systemRoot).root.slice(0, -1);
    clean.PATH = `${systemRoot}\\System32;${systemRoot}`;
    clean.PSModulePath = path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'Modules');
  } else clean.PATH = '/usr/bin:/bin:/usr/sbin:/sbin';
  return clean;
}

// Internal primitive. CLI inputs never select the executable or create a shell.
export function runBounded(executable, args, options = {}) {
  const timeoutMs = Math.max(1, Math.min(options.timeoutMs ?? 5000, 30000));
  const maxBuffer = Math.max(1, Math.min(options.maxBuffer ?? 2 * 1024 * 1024, 16 * 1024 * 1024));
  return new Promise((resolve) => {
    let child;
    let done = false;
    let timer;
    const stdout = [];
    const stderr = [];
    let size = 0;
    const finish = (result) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(stdout).toString('utf8'), stderr: Buffer.concat(stderr).toString('utf8'), ...result });
    };
    const abort = (error) => {
      child?.stdout?.destroy();
      child?.stderr?.destroy();
      try { child?.kill('SIGKILL'); } catch { /* Process may already have exited. */ }
      child?.unref();
      finish({ ok: false, code: null, error });
    };
    try {
      child = (options.spawn ?? spawn)(executable, args, {
        cwd: options.cwd,
        env: options.env ?? safeEnvironment(),
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      finish({ ok: false, code: null, error: error.code || 'SPAWN_FAILED' });
      return;
    }
    timer = setTimeout(() => abort('TIMEOUT'), timeoutMs);
    timer.unref();
    for (const [stream, chunks] of [[child.stdout, stdout], [child.stderr, stderr]]) {
      stream.on('data', (chunk) => {
        if (done) return;
        size += chunk.length;
        if (size > maxBuffer) { abort('OUTPUT_LIMIT'); return; }
        chunks.push(chunk);
      });
    }
    child.once('error', (error) => finish({ ok: false, code: null, error: error.code || 'SPAWN_FAILED', unavailable: error.code === 'ENOENT' }));
    child.once('close', (code, signal) => finish({ ok: code === 0, code, ...(signal ? { error: signal } : {}) }));
  });
}

const KNOWN_FOLDERS_SCRIPT = [
  // .NET Framework calls SHGetFolderPath for these fixed machine folders.
  // DoNotVerify avoids existence checks and never creates a directory.
  // https://learn.microsoft.com/dotnet/api/system.environment.specialfolderoption
  // https://learn.microsoft.com/windows/win32/api/shlobj_core/nf-shlobj_core-shgetfolderpathw
  "$ErrorActionPreference = 'Stop'",
  // Windows PowerShell can rebuild PSModulePath at startup; reset it before work.
  "$env:PSModulePath = $PSHOME + '\\Modules'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  '[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFiles, [Environment+SpecialFolderOption]::DoNotVerify))',
  '[Console]::Write([char]0)',
  '[Console]::Write([Environment]::GetFolderPath([Environment+SpecialFolder]::ProgramFilesX86, [Environment+SpecialFolderOption]::DoNotVerify))',
].join('; ');

let cachedKnownFolders;
async function windowsKnownFolders(env, options, deadline) {
  const native = process.platform === 'win32' && !Object.hasOwn(options, 'nativeRealpath') && !options.fs && !options.spawn;
  if (native && cachedKnownFolders) {
    try { return await beforeDeadline(() => cachedKnownFolders, deadline); }
    catch { return []; }
  }
  const collect = async () => {
    const executable = systemCandidates('powershell', 'win32', env, options)[0];
    const remaining = Math.floor(deadline - performance.now());
    if (!executable || remaining < 1) return [];
    const result = await runBounded(executable, ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', KNOWN_FOLDERS_SCRIPT], {
      cwd: windowsRoot(options), env: safeEnvironment(env, 'win32', options), spawn: options.spawn,
      timeoutMs: Math.min(1500, remaining), maxBuffer: 4096,
    });
    if (!result.ok) return [];
    const fields = result.stdout.split('\u0000');
    if (fields.length !== 2) return [];
    const roots = [];
    for (const field of fields) {
      if (!field) continue;
      const root = localWindowsDirectory(field);
      if (!root) return [];
      if (!roots.some(existing => existing.toLowerCase() === root.toLowerCase())) roots.push(root);
    }
    return roots;
  };
  const result = collect();
  if (native) cachedKnownFolders = result;
  return result;
}

async function beforeDeadline(operation, deadline) {
  const remaining = Math.floor(deadline - performance.now());
  if (remaining < 1) throw Object.assign(new Error('Operation timed out.'), { code: 'TIMEOUT' });
  let timer;
  try {
    return await Promise.race([
      operation(),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Object.assign(new Error('Operation timed out.'), { code: 'TIMEOUT' })), remaining);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runSystem(name, args, options = {}) {
  const deadline = performance.now() + Math.max(1, Math.min(options.timeoutMs ?? 5000, 30000));
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const fileSystem = options.fs ?? { stat, access };
  const normalized = name.replace(/\.exe$/i, '').toLowerCase();
  if (platform === 'win32' && normalized === 'git') {
    options = { ...options, knownFolders: await windowsKnownFolders(env, options, deadline) };
  }
  for (const executable of systemCandidates(name, platform, env, options)) {
    try {
      if (!(await beforeDeadline(() => fileSystem.stat(executable), deadline)).isFile()) continue;
      await beforeDeadline(() => fileSystem.access(executable, platform === 'win32' ? constants.F_OK : constants.X_OK), deadline);
    } catch (error) {
      if (error.code === 'TIMEOUT') return { ok: false, stdout: '', stderr: '', code: null, error: 'TIMEOUT' };
      continue;
    }
    const remaining = Math.floor(deadline - performance.now());
    if (remaining < 1) return { ok: false, stdout: '', stderr: '', code: null, error: 'TIMEOUT' };
    const actualArgs = normalized === 'git'
      ? ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
        '-c', 'core.hooksPath=' + (platform === 'win32' ? 'NUL' : '/dev/null'), ...args]
      : args;
    return runBounded(executable, actualArgs, { ...options, timeoutMs: remaining, env: safeEnvironment(env, platform, options) });
  }
  return { ok: false, stdout: '', stderr: '', code: null, unavailable: true, error: 'TRUSTED_TOOL_NOT_FOUND' };
}
