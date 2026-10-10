import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { runSystem } from './process.mjs';

const DOCS = {
  names: 'https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file',
  case: 'https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity',
  attributes: 'https://git-scm.com/docs/gitattributes',
  index: 'https://git-scm.com/docs/git-ls-files',
  modes: 'https://git-scm.com/docs/git-update-index',
  symlinks: 'https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks',
};

const EXCLUDED_DIRECTORIES = new Set([
  '.git', 'node_modules', '.venv', 'venv', 'env', '.tox', '.nox',
  '__pycache__', '.cache', '.next', '.nuxt', '.turbo', '.parcel-cache',
  'build', 'dist', 'out', 'target', 'coverage', 'vendor', 'bower_components',
]);
const SHELL_EXTENSIONS = new Set(['.sh', '.bash', '.zsh', '.ksh', '.bats', '.command']);
const SCRIPT_EXTENSIONS = new Set([
  ...SHELL_EXTENSIONS, '.fish', '.py', '.rb', '.pl', '.lua', '.js', '.mjs', '.cjs', '.ts',
]);
const SCRIPT_DIRECTORIES = new Set(['bin', 'scripts', 'script', 'tools', 'hooks']);
const PRIVATE_EXTENSIONS = new Set(['.pem', '.key', '.p12', '.pfx', '.p8', '.ppk', '.jks', '.keystore']);
const PRIVATE_NAMES = new Set([
  '.ssh', '.gnupg', '.aws', '.azure', '.kube', '.secrets', 'secrets',
  '.npmrc', '.pypirc', '.netrc', '.git-credentials', 'credentials', 'credentials.json',
]);
const EVIDENCE_LIMIT = 12;

function boundedInteger(value, fallback, maximum) {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, maximum) : fallback;
}

function sensitivePath(relative) {
  return relative.split('/').some((part) => {
    const name = part.toLowerCase();
    return name.startsWith('.env') || PRIVATE_NAMES.has(name)
      || /^id_(rsa|dsa|ecdsa|ed25519)(?:\.|$)/u.test(name)
      || /^(credentials|secrets)(?:\.|$)/u.test(name)
      || /(?:^|[._-])private[._-]?key(?:[._-]|$)/u.test(name)
      || PRIVATE_EXTENSIONS.has(path.posix.extname(name));
  });
}

function excludedPath(relative) {
  return relative.split('/').some((part) => EXCLUDED_DIRECTORIES.has(part.toLowerCase()));
}

function headerCandidate(record) {
  if (record.type !== 'file' || sensitivePath(record.relative) || excludedPath(record.relative)) return false;
  const extension = path.posix.extname(record.relative).toLowerCase();
  if (SCRIPT_EXTENSIONS.has(extension) || record.mode === '100755') return true;
  if (extension) return false;
  const parts = record.relative.split('/');
  return parts.slice(0, -1).some((part) => SCRIPT_DIRECTORIES.has(part.toLowerCase()))
    || ['gradlew', 'mvnw', 'configure'].includes(parts.at(-1));
}

function validMetadataPath(relative) {
  if (!relative || relative.length > 16_384 || relative.startsWith('/')
      || /^[A-Za-z]:/u.test(relative) || relative.startsWith('\\')) return false;
  const parts = relative.split('/');
  return !parts.some((part) => !part || part === '.' || part === '..' || part.toLowerCase() === '.git')
    && !relative.split('\\').some((part) => part === '.' || part === '..');
}

function contained(root, target) {
  const relative = path.relative(root, target);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

function evidence(values) {
  return [...values].sort().slice(0, EVIDENCE_LIMIT).map((value) => value.length > 512 ? `${value.slice(0, 509)}...` : value);
}

function filenameIssues(records, canContinue, maximum, onLimit) {
  const invalid = new Map();
  const folded = new Map();
  const seen = new Set();
  let limited = false;
  for (const { relative } of records) {
    const parts = relative.split('/');
    let prefix = '';
    for (let i = 0; i < parts.length; i++) {
      if (!canContinue()) { limited = true; break; }
      const component = parts[i];
      prefix = prefix ? `${prefix}/${component}` : component;
      if (seen.has(prefix)) continue;
      if (seen.size >= maximum) { onLimit('path component count'); limited = true; break; }
      seen.add(prefix);
      const reasons = [];
      if (/[<>:"\\|?*\u0000-\u001f]/u.test(component)) reasons.push('Windows-reserved character');
      if (/[ .]$/u.test(component)) reasons.push('trailing space or period');
      if (/^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])(?:\.|$)/iu.test(component)) reasons.push('Windows device name');
      if (reasons.length) invalid.set(prefix, `${prefix}: ${reasons.join(', ')}`);
      const key = prefix.toLowerCase();
      if (!folded.has(key)) folded.set(key, new Set());
      folded.get(key).add(prefix);
    }
    if (limited) break;
  }
  const collisions = [...folded.values()].filter((names) => names.size > 1);
  return { invalid, collisions };
}

function scriptHeader(buffer, relative) {
  const shell = SHELL_EXTENSIONS.has(path.posix.extname(relative).toLowerCase());
  const utf8Bom = buffer.length >= 3 && buffer[0] === 0xef && buffer[1] === 0xbb && buffer[2] === 0xbf;
  const wideBom = buffer.length >= 2 && ((buffer[0] === 0xff && buffer[1] === 0xfe)
    || (buffer[0] === 0xfe && buffer[1] === 0xff))
    || (buffer.length >= 4 && buffer[0] === 0 && buffer[1] === 0 && buffer[2] === 0xfe && buffer[3] === 0xff);
  const content = utf8Bom ? buffer.subarray(3) : buffer;
  const shebang = content.length >= 2 && content[0] === 0x23 && content[1] === 0x21;
  const bom = (utf8Bom || wideBom) && (shell || shebang);
  const binary = content.includes(0) && !bom;
  if (binary || (!shell && !shebang)) return { binary, unix: false, bom: false, crlf: false, shebang: false };
  const firstNewline = content.indexOf(0x0a);
  const shebangCrlf = shebang && firstNewline > 0 && content[firstNewline - 1] === 0x0d;
  const crlf = shebangCrlf || (shell && content.includes(Buffer.from('\r\n')));
  return { binary: false, unix: true, bom, crlf, shebang, shebangCrlf };
}

class BudgetError extends Error {}

/** Inspect tracked project paths, or a bounded directory tree when Git is unavailable. */
export async function inspectProject(root, environment = {}, options = {}) {
  const run = options.run ?? runSystem;
  const now = options.now ?? (() => performance.now());
  const limits = {
    maxFiles: boundedInteger(options.maxFiles, 10_000, 100_000),
    maxEntries: boundedInteger(options.maxEntries, 20_000, 200_000),
    maxDepth: boundedInteger(options.maxDepth, 64, 128),
    headerBytes: boundedInteger(options.headerBytes, 8192, 32_768),
    maxBytes: boundedInteger(options.maxBytes, 8 * 1024 * 1024, 64 * 1024 * 1024),
    maxDurationMs: boundedInteger(options.maxDurationMs, 5000, 30_000),
    maxGitBytes: boundedInteger(options.maxGitBytes, 4 * 1024 * 1024, 16 * 1024 * 1024),
  };
  const deadline = now() + limits.maxDurationMs;
  const project = {
    root: path.resolve(root), source: 'filesystem', gitStatus: 'unknown', indexEmpty: null,
    scannedFiles: 0, scannedPaths: 0, inspectedHeaders: 0, unixHeaders: 0,
    bytesRead: 0, skippedSensitive: 0, skippedGenerated: 0, binaryHeaders: 0,
    inaccessible: 0, invalidMetadata: 0, symlinks: 0, submodules: 0,
    truncated: false, complete: true,
  };
  const checks = [];
  const records = new Map();
  const limitsHit = new Set();
  const inaccessible = new Set();
  const symlinks = new Set();
  const submodules = new Set();
  const crlf = new Set();
  const bom = new Set();
  const nonExecutable = new Set();
  let shebangCrlf = false;
  let gitError = false;
  let canonicalRoot;

  function hitLimit(reason) {
    project.truncated = true;
    limitsHit.add(reason);
  }
  function timeAvailable() {
    if (now() < deadline) return true;
    hitLimit('elapsed time');
    return false;
  }
  async function bounded(operation, disposeLate) {
    if (!timeAvailable()) throw new BudgetError();
    let expired = false;
    let timer;
    const pending = Promise.resolve().then(operation).then((value) => {
      if (expired && disposeLate) Promise.resolve(disposeLate(value)).catch(() => {});
      return value;
    });
    try {
      return await Promise.race([
        pending,
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            expired = true;
            hitLimit('elapsed time');
            reject(new BudgetError());
          }, Math.max(1, deadline - now()));
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  async function closeResource(resource) {
    const closing = resource.close().catch(() => {});
    if (now() < deadline) await bounded(() => closing).catch(() => {});
  }
  function addRecord(record) {
    if (records.has(record.relative)) {
      if (record.stage === '0') records.set(record.relative, record);
      return true;
    }
    if (records.size >= limits.maxEntries) { hitLimit('path count'); return false; }
    if (record.type !== 'directory' && project.scannedFiles >= limits.maxFiles) { hitLimit('file count'); return false; }
    records.set(record.relative, record);
    if (record.type !== 'directory') project.scannedFiles++;
    return true;
  }
  function recordError(relative, error) {
    if (error instanceof BudgetError) return;
    inaccessible.add(relative);
  }

  // Establish the explicitly requested directory. Symlink entries below it are never traversed.
  try {
    const stat = await bounded(() => fs.lstat(project.root));
    if (stat.isSymbolicLink() || !stat.isDirectory()) {
      checks.push({
        id: 'project.root', status: 'fail', title: 'Project root must be a real directory',
        detail: stat.isSymbolicLink() ? 'The requested root is a symlink; its target was not inspected.' : 'The requested path is not a directory.',
        remedy: 'Pass the intended directory itself with --project.',
      });
      project.complete = false;
      return { checks, project };
    }
    canonicalRoot = await bounded(() => fs.realpath(project.root));
  } catch (error) {
    checks.push({
      id: 'project.root', status: 'fail', title: 'Project directory could not be inspected',
      detail: error instanceof BudgetError ? 'The inspection time budget expired.' : 'The directory does not exist or is not accessible.',
      remedy: 'Check the project path and your normal user permissions.',
    });
    project.complete = false;
    return { checks, project };
  }

  async function checkedPath(relative) {
    const components = relative.split('/');
    let current = canonicalRoot;
    for (let index = 0; index < components.length; index++) {
      current = path.resolve(current, components[index]);
      if (!contained(canonicalRoot, current)) throw new Error('path outside project');
      const stat = await bounded(() => fs.lstat(current));
      if (stat.isSymbolicLink()) {
        symlinks.add(components.slice(0, index + 1).join('/'));
        return null;
      }
      if (index < components.length - 1 && !stat.isDirectory()) throw new Error('non-directory parent');
      if (index === components.length - 1) return { absolute: current, stat };
    }
    return null;
  }

  async function gitCommand(args, maxBuffer = limits.maxGitBytes) {
    try {
      return await bounded(() => run('git', args, {
        cwd: canonicalRoot, platform: environment.platform,
        timeoutMs: Math.max(1, Math.min(2000, deadline - now())), maxBuffer,
      }));
    } catch (error) {
      return { ok: false, code: null, error: error instanceof BudgetError ? 'timeout' : 'unavailable' };
    }
  }

  const probe = await gitCommand(['rev-parse', '--is-inside-work-tree'], 4096);
  if (probe.unavailable) project.gitStatus = 'unavailable';
  else if (probe.ok && String(probe.stdout).trim() === 'true') {
    project.gitStatus = 'worktree';
    const index = await gitCommand(['ls-files', '--stage', '-z']);
    if (index.ok && typeof index.stdout === 'string') {
      project.source = 'git';
      project.indexEmpty = index.stdout.length === 0;
      let output = index.stdout;
      if (Buffer.byteLength(output) > limits.maxGitBytes) {
        hitLimit('Git output');
        output = Buffer.from(output).subarray(0, limits.maxGitBytes).toString('utf8');
        output = output.slice(0, output.lastIndexOf('\0') + 1);
      }
      if (output && !output.endsWith('\0')) project.invalidMetadata++;
      let offset = 0;
      while (offset < output.length && timeAvailable()) {
        const end = output.indexOf('\0', offset);
        if (end < 0) break;
        const row = output.slice(offset, end);
        offset = end + 1;
        const match = /^(100644|100755|120000|160000) ([0-9a-f]{40}|[0-9a-f]{64}) ([0-3])\t([\s\S]+)$/u.exec(row);
        if (!match || !validMetadataPath(match[4])) { project.invalidMetadata++; continue; }
        if (match[4].split('/').length > limits.maxDepth + 1) { hitLimit('Git path depth'); continue; }
        const [, mode, , stage, relative] = match;
        const type = mode === '120000' ? 'symlink' : mode === '160000' ? 'submodule' : 'file';
        if (!addRecord({ relative, mode, stage, type })) break;
      }
    } else {
      project.gitStatus = index.unavailable ? 'unavailable' : 'error';
      gitError = !index.unavailable;
    }
  } else if (probe.ok || /not a git repository|not a work tree/iu.test(String(probe.stderr ?? ''))) {
    project.gitStatus = 'not-repository';
  } else {
    project.gitStatus = 'error';
    gitError = true;
  }

  if (project.source === 'filesystem') {
    let visitedEntries = 0;
    async function walk(relative = '', depth = 0) {
      if (!timeAvailable() || project.truncated) return;
      if (depth > limits.maxDepth) { hitLimit('directory depth'); return; }
      let directory;
      try {
        const safe = relative ? await checkedPath(relative) : { absolute: canonicalRoot };
        if (!safe) return;
        directory = await bounded(() => fs.opendir(safe.absolute), (late) => late.close());
        while (timeAvailable()) {
          const entry = await bounded(() => directory.read());
          if (!entry) break;
          if (++visitedEntries > limits.maxEntries) { hitLimit('directory entry count'); break; }
          const name = relative ? `${relative}/${entry.name}` : entry.name;
          if (entry.isDirectory() && (EXCLUDED_DIRECTORIES.has(entry.name.toLowerCase()) || sensitivePath(name))) {
            if (sensitivePath(name)) project.skippedSensitive++; else project.skippedGenerated++;
            continue;
          }
          const type = entry.isSymbolicLink() ? 'symlink' : entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'special';
          if (!addRecord({ relative: name, mode: null, type })) break;
          if (type === 'directory') await walk(name, depth + 1);
          if (project.truncated) break;
        }
      } catch (error) {
        recordError(relative || '.', error);
      } finally {
        if (directory) await closeResource(directory);
      }
    }
    await walk();
  }

  async function readHeader(record) {
    let handle;
    try {
      const safe = await checkedPath(record.relative);
      if (!safe || !safe.stat.isFile()) return;
      const resolved = await bounded(() => fs.realpath(safe.absolute));
      if (!contained(canonicalRoot, resolved)) throw new Error('path outside project');
      const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
      handle = await bounded(() => fs.open(safe.absolute, flags), (late) => late.close());
      const opened = await bounded(() => handle.stat());
      if (!opened.isFile() || !sameFile(opened, safe.stat)) throw new Error('file changed during inspection');
      // Check parent components again before reading from the already-open handle.
      const verified = await checkedPath(record.relative);
      if (!verified) return;
      if (!sameFile(verified.stat, opened)) throw new Error('file changed during inspection');
      const size = Math.min(limits.headerBytes, limits.maxBytes - project.bytesRead, opened.size);
      if (size <= 0 && opened.size > 0) { hitLimit('header byte count'); return; }
      const buffer = Buffer.alloc(size);
      const { bytesRead } = await bounded(() => handle.read(buffer, 0, size, 0));
      project.bytesRead += bytesRead;
      project.inspectedHeaders++;
      const header = scriptHeader(buffer.subarray(0, bytesRead), record.relative);
      if (header.binary) project.binaryHeaders++;
      if (header.unix) project.unixHeaders++;
      if (header.crlf) crlf.add(record.relative);
      if (header.bom) bom.add(record.relative);
      if (header.shebang && record.mode === '100644') nonExecutable.add(record.relative);
      shebangCrlf ||= header.shebangCrlf;
      if (size < Math.min(limits.headerBytes, opened.size)) hitLimit('header byte count');
    } catch (error) {
      recordError(record.relative, error);
    } finally {
      if (handle) await closeResource(handle);
    }
  }

  for (const record of [...records.values()].sort((a, b) => a.relative.localeCompare(b.relative))) {
    if (record.type === 'symlink') { symlinks.add(record.relative); continue; }
    if (record.type === 'submodule') { submodules.add(record.relative); continue; }
    if (sensitivePath(record.relative)) { project.skippedSensitive++; continue; }
    if (!headerCandidate(record)) continue;
    if (!timeAvailable()) break;
    if (project.bytesRead >= limits.maxBytes) { hitLimit('header byte count'); break; }
    await readHeader(record);
  }

  const names = filenameIssues(records.values(), timeAvailable, limits.maxEntries, hitLimit);
  project.scannedPaths = records.size;
  project.inaccessible = inaccessible.size;
  project.symlinks = symlinks.size;
  project.submodules = submodules.size;
  project.complete = !project.truncated && !project.invalidMetadata && !project.inaccessible && !gitError;
  const cleanStatus = project.complete ? 'pass' : 'info';
  checks.push({
    id: 'project.scope', status: project.gitStatus === 'unavailable' ? 'skip' : 'info',
    title: project.source === 'git' ? 'Project paths came from the Git index' : 'Project paths came from a bounded directory scan',
    detail: project.source === 'git'
      ? `${project.scannedFiles} tracked paths inspected in this directory. Untracked files are excluded.${project.indexEmpty ? ' The index is empty here; this does not establish that untracked files are portable.' : ''}`
      : `${project.scannedFiles} files inspected. ${project.gitStatus === 'unavailable' ? 'A trusted system Git executable was unavailable.' : project.gitStatus === 'not-repository' ? 'This directory is not a Git work tree.' : 'Git metadata could not be read.'} Dependency, build, cache, and private directories are excluded.`,
    docs: DOCS.index,
  });
  if (!project.complete) checks.push({
    id: 'project.incomplete', status: 'warn', title: 'Project inspection was incomplete',
    detail: [
      limitsHit.size ? `Reached limit: ${[...limitsHit].join(', ')}.` : '',
      inaccessible.size ? `${inaccessible.size} paths were missing, inaccessible, changed, or unsafe to open.` : '',
      project.invalidMetadata ? `${project.invalidMetadata} malformed or unsafe Git metadata records were ignored.` : '',
      gitError ? 'Git metadata was unavailable; a directory scan cannot verify all index-only paths.' : '',
    ].filter(Boolean).join(' '),
    evidence: evidence(inaccessible),
    remedy: 'Inspect a smaller project directory or resolve the reported access problem, then run the check again.',
  });

  if (names.invalid.size) checks.push({
    id: 'project.windows-names', status: 'warn', title: 'Paths may not work with Windows tools',
    detail: `${names.invalid.size} path components use Windows-reserved names, characters, or endings.`,
    evidence: evidence(names.invalid.values()),
    remedy: 'Rename these components in a reviewed change if the project must support Windows tools.', docs: DOCS.names,
  });
  else if (records.size) checks.push({
    id: 'project.windows-names', status: cleanStatus, title: 'No Windows-incompatible names found in inspected paths',
    detail: `${records.size} paths checked for reserved names, characters, and trailing spaces or periods.`, docs: DOCS.names,
  });
  if (names.collisions.length) checks.push({
    id: 'project.case-collisions', status: 'warn', title: 'Paths collide when letter case is ignored',
    detail: `${names.collisions.length} file or directory path groups differ only by letter case. Typical Windows checkouts cannot preserve them independently.`,
    evidence: evidence(names.collisions.map((group) => [...group].sort().join(' | '))),
    remedy: 'Choose distinct names and update references. Do not change core.ignorecase to hide the collision.', docs: DOCS.case,
  });
  else if (records.size) checks.push({
    id: 'project.case-collisions', status: cleanStatus, title: 'No case collisions found in inspected paths',
    detail: 'File names and directory prefixes were compared without letter case.', docs: DOCS.case,
  });
  const unixHost = (environment.platform ?? process.platform) !== 'win32';
  if (crlf.size) checks.push({
    id: 'project.script-crlf', status: unixHost && shebangCrlf ? 'fail' : 'warn',
    title: 'Unix script headers contain CRLF line endings',
    detail: `${crlf.size} script headers contain carriage returns that can become part of an interpreter name or shell token. Only the first ${limits.headerBytes} bytes per candidate were inspected.`,
    evidence: evidence(crlf), remedy: 'Use LF for Unix scripts and a targeted .gitattributes rule such as *.sh text eol=lf. Review any normalization diff before committing.', docs: DOCS.attributes,
  });
  if (bom.size) checks.push({
    id: 'project.script-bom', status: unixHost ? 'fail' : 'warn', title: 'Unix script headers contain a byte order mark',
    detail: `${bom.size} Unix script headers have a byte order mark before the script or its shebang. Direct Unix execution can fail.`,
    evidence: evidence(bom), remedy: 'Save intended Unix scripts as UTF-8 without a BOM, preserving their contents and LF line endings.', docs: DOCS.attributes,
  });
  if (!crlf.size && !bom.size) checks.push({
    id: 'project.script-headers', status: project.unixHeaders ? cleanStatus : 'skip',
    title: project.unixHeaders ? 'No CRLF or BOM found in inspected Unix script headers' : 'No Unix script headers were inspected',
    detail: `${project.inspectedHeaders} candidate headers sampled, up to ${limits.headerBytes} bytes each; ${project.unixHeaders} identified as Unix scripts. File bodies beyond those samples were not inspected.`,
    docs: DOCS.attributes,
  });
  if (nonExecutable.size) checks.push({
    id: 'project.script-mode', status: 'info', title: 'Some shebang scripts are not executable in Git',
    detail: `${nonExecutable.size} shebang scripts have index mode 100644. This is fine when an interpreter runs them, but does not support direct ./script invocation after a Unix checkout.`,
    evidence: evidence(nonExecutable), remedy: 'If direct execution is intended, review git update-index --chmod=+x -- <path>; otherwise keep invoking the interpreter explicitly.', docs: DOCS.modes,
  });
  if (symlinks.size) checks.push({
    id: 'project.symlinks', status: 'info', title: 'Symlink targets were not inspected',
    detail: `${symlinks.size} symlink entries or symlinked parent paths were skipped. Symlink checkout behavior also depends on platform and Git configuration.`,
    evidence: evidence(symlinks), remedy: 'Check required symlinks separately in each supported environment.', docs: DOCS.symlinks,
  });
  if (submodules.size) checks.push({
    id: 'project.submodules', status: 'info', title: 'Submodule contents were not inspected',
    detail: `${submodules.size} Git submodule paths were found; this inspection does not recurse into their repositories.`,
    evidence: evidence(submodules), remedy: 'Run WSLens separately inside any submodule that needs checking.', docs: DOCS.index,
  });
  return { checks, project };
}
