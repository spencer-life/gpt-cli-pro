import { spawn } from 'node:child_process';
import { access, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';

const POSIX_COMMANDS = {
  git: ['/usr/bin/git', '/bin/git', '/usr/local/bin/git', '/opt/homebrew/bin/git'],
  ss: ['/usr/bin/ss', '/bin/ss', '/usr/sbin/ss'],
  lsof: ['/usr/sbin/lsof', '/usr/bin/lsof', '/sbin/lsof'],
  netstat: ['/usr/bin/netstat', '/bin/netstat', '/usr/sbin/netstat'],
};

function envValue(env, name) {
  return Object.entries(env).find(([key]) => key.toLowerCase() === name.toLowerCase())?.[1];
}

export function systemCandidates(name, platform = process.platform, env = process.env) {
  const normalized = name.replace(/\.exe$/i, '').toLowerCase();
  if (platform !== 'win32') return Object.hasOwn(POSIX_COMMANDS, normalized) ? POSIX_COMMANDS[normalized] : [];
  const systemRoot = envValue(env, 'SystemRoot') || 'C:\\Windows';
  const programFiles = envValue(env, 'ProgramW6432') || envValue(env, 'ProgramFiles') || 'C:\\Program Files';
  const localData = envValue(env, 'LOCALAPPDATA');
  const candidates = {
    git: [path.win32.join(programFiles, 'Git', 'cmd', 'git.exe'),
      path.win32.join(programFiles, 'Git', 'bin', 'git.exe'),
      ...(localData ? [path.win32.join(localData, 'Programs', 'Git', 'cmd', 'git.exe')] : [])],
    powershell: [path.win32.join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe')],
    netstat: [path.win32.join(systemRoot, 'System32', 'netstat.exe')],
  };
  return Object.hasOwn(candidates, normalized) ? candidates[normalized] : [];
}

export function safeEnvironment(env = process.env, platform = process.platform) {
  const allowed = new Set(['home', 'userprofile', 'systemroot', 'windir', 'temp', 'tmp', 'tmpdir',
    'programfiles', 'programfiles(x86)', 'programw6432', 'localappdata', 'appdata']);
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
    const systemRoot = envValue(env, 'SystemRoot') || 'C:\\Windows';
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
      child = spawn(executable, args, {
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

export async function runSystem(name, args, options = {}) {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  for (const executable of systemCandidates(name, platform, env)) {
    try {
      if (!(await stat(executable)).isFile()) continue;
      await access(executable, platform === 'win32' ? constants.F_OK : constants.X_OK);
    } catch { continue; }
    const actualArgs = name.replace(/\.exe$/i, '').toLowerCase() === 'git'
      ? ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
        '-c', 'core.hooksPath=' + (platform === 'win32' ? 'NUL' : '/dev/null'), ...args]
      : args;
    return runBounded(executable, actualArgs, { ...options, env: safeEnvironment(env, platform) });
  }
  return { ok: false, stdout: '', stderr: '', code: null, unavailable: true, error: 'TRUSTED_TOOL_NOT_FOUND' };
}
