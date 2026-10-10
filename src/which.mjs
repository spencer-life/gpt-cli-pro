import * as nativeFs from 'node:fs/promises';
import { constants } from 'node:fs';
import path from 'node:path';
import { classifyFilesystem, createIoBudget } from './environment.mjs';

const MAX_PATH_LENGTH = 128 * 1024;
const MAX_PATH_ENTRIES = 256;
const MAX_COMMANDS = 32;
const MAX_LOOKUPS = 8192;
const MAX_DIRECTORY_ENTRIES = 8192;
const MAX_TOTAL_DIRECTORY_ENTRIES = 65536;
const MAX_EVIDENCE = 12;
const WINDOWS_DEFAULT_EXTENSIONS = '.COM;.EXE;.BAT;.CMD';
const COMMAND_DOCS = 'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence';
const PATH_NOTE = 'PATH-only external-file lookup. Shell aliases, functions, built-ins, cached resolutions, and implicit current-directory searches are not inspected; executables are never run.';

function windowsSegments(value) {
  const segments = [];
  let start = 0;
  let quoted = false;
  for (let index = 0; index < value.length; index += 1) {
    if (value[index] === '"') quoted = !quoted;
    if (value[index] === ';' && !quoted) {
      segments.push(value.slice(start, index));
      start = index + 1;
    }
  }
  segments.push(value.slice(start));
  return segments;
}

function normalizeKey(value, platform) {
  return platform === 'win32' ? path.win32.normalize(value).toLowerCase() : path.posix.normalize(value);
}

function pathDetails(pathValue, platform, cwd) {
  const value = typeof pathValue === 'string' ? pathValue : '';
  const bounded = value.slice(0, MAX_PATH_LENGTH);
  const parts = platform === 'win32' ? windowsSegments(bounded) : bounded.split(':');
  const truncated = value.length > MAX_PATH_LENGTH || parts.length > MAX_PATH_ENTRIES;
  // A character limit may cut through a real directory name. Never resolve the
  // resulting prefix as though it were a complete PATH entry.
  if (value.length > MAX_PATH_LENGTH) parts.pop();
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  const seen = new Map();
  const entries = parts.slice(0, MAX_PATH_ENTRIES).map((raw, index) => {
    let directory = raw;
    let quoted = false;
    let invalid = false;
    if (platform === 'win32') {
      directory = directory.trim();
      if (directory.startsWith('"') && directory.endsWith('"') && directory.length > 1) {
        quoted = true;
        directory = directory.slice(1, -1);
      }
      invalid = directory.includes('"');
    }
    invalid ||= directory.includes('\0');
    const empty = directory.length === 0;
    const driveRelative = platform === 'win32' && /^[a-z]:(?![\\/])/i.test(directory);
    const rootRelative = platform === 'win32' && /^[\\/](?![\\/])/.test(directory);
    const relative = empty || !pathApi.isAbsolute(directory) || driveRelative || rootRelative;
    let resolved = null;
    // Windows empty PATH entries do not imply the PowerShell current directory.
    // cmd.exe's independent current-directory search is outside this model.
    if (!invalid && !(empty && platform === 'win32')) {
      if (!driveRelative || directory.slice(0, 2).toLowerCase() === cwd.slice(0, 2).toLowerCase()) {
        resolved = pathApi.resolve(cwd, directory || '.');
      }
    }
    const key = resolved ? normalizeKey(resolved, platform) : null;
    const duplicateOf = key !== null && seen.has(key) ? seen.get(key) : null;
    if (key !== null && duplicateOf === null) seen.set(key, index);
    return { index, raw, path: resolved, empty, relative, quoted, invalid, driveRelative, rootRelative, duplicateOf };
  });
  return { entries, truncated };
}

/** POSIX quotes are literal; Windows surrounding quotes and quoted semicolons work. */
export function parsePathEntries(pathValue, platform = process.platform, cwd = process.cwd()) {
  return pathDetails(pathValue, platform, cwd).entries;
}

/** PATHEXT order is preserved, duplicates removed, and path syntax is rejected. */
export function parsePathExt(value) {
  const source = value === undefined || value === null ? WINDOWS_DEFAULT_EXTENSIONS : String(value);
  const result = [];
  for (const extension of source.slice(0, 8192).split(';').slice(0, 32)) {
    const normalized = extension.trim().toLowerCase();
    if (/^\.[a-z0-9]{1,12}$/.test(normalized) && !result.includes(normalized)) result.push(normalized);
  }
  return result;
}

function getEntries(environment) {
  if (environment.pathDefined === false) return { entries: [], truncated: false };
  const cwd = environment.cwd ?? (environment.platform === 'win32' ? 'C:\\' : process.cwd());
  return pathDetails(environment.pathValue, environment.platform, cwd);
}

function evidence(values) { return values.slice(0, MAX_EVIDENCE); }
function code(error) { return typeof error?.code === 'string' ? error.code : 'UNKNOWN'; }
function absent(error) { return ['ENOENT', 'ENOTDIR'].includes(code(error)); }

function boundedIo(environment, budget) {
  const underlying = { ...nativeFs, ...(environment.fs ?? {}) };
  const io = {};
  for (const method of ['stat', 'lstat', 'realpath', 'access']) {
    io[method] = (...args) => budget.run(() => underlying[method](...args));
  }
  io.opendir = async (...args) => {
    const handle = await budget.run(() => underlying.opendir(...args), (lateHandle) => lateHandle.close());
    return {
      read: () => budget.run(() => handle.read()),
      async close() {
        const closing = handle.close();
        closing.catch(() => {});
        if (!budget.expired) await budget.run(() => closing);
      },
    };
  };
  return io;
}

export async function inspectPath(environment, options = {}) {
  const budget = createIoBudget(options);
  const io = boundedIo(environment, budget);
  const { entries, truncated } = getEntries(environment);
  for (const entry of entries) {
    entry.exists = null;
    entry.directory = null;
    if (entry.path === null) continue;
    try {
      const result = await io.stat(entry.path);
      entry.exists = true;
      entry.directory = result.isDirectory();
    } catch (error) {
      entry.exists = absent(error) ? false : null;
      entry.error = code(error);
    }
  }
  const checks = [];
  const empty = entries.filter((entry) => entry.empty);
  const relative = entries.filter((entry) => entry.relative && !entry.empty);
  const duplicates = entries.filter((entry) => entry.duplicateOf !== null);
  const missing = entries.filter((entry) => entry.exists === false || entry.directory === false);
  const unreadable = entries.filter((entry) => entry.error && entry.exists === null);
  const invalid = entries.filter((entry) => entry.invalid || (entry.driveRelative && entry.path === null));
  const timedOut = budget.timeouts > 0 || budget.expired;
  if (environment.pathDefined === false) checks.push({ id: 'path.unset', status: 'warn', title: 'PATH is not set',
    detail: 'No inherited PATH was available. Shell-specific default search directories are not inferred.',
    remedy: 'Check the environment supplied by the terminal or editor that launches your tools.' });
  if (empty.length) checks.push({ id: 'path.empty', status: 'warn', title: `${empty.length} empty PATH ${empty.length === 1 ? 'entry' : 'entries'}`,
    detail: environment.platform === 'win32' ? 'Empty entries are ignored by this PATH-only Windows lookup. Current-directory behavior varies by shell.' : 'An empty POSIX PATH entry searches the current directory, so resolution can change as you move between projects.',
    evidence: evidence(empty.map((entry) => `PATH entry ${entry.index + 1}`)),
    remedy: 'Remove unintended empty entries from the configuration that constructs PATH.' });
  if (relative.length) checks.push({ id: 'path.relative', status: 'warn', title: `${relative.length} relative PATH ${relative.length === 1 ? 'entry' : 'entries'}`,
    detail: 'Relative search directories can resolve differently in another working directory. A drive-relative Windows path on another drive cannot be resolved from this process context.',
    evidence: evidence(relative.map((entry) => entry.raw)), remedy: 'Use an absolute directory for stable command resolution.' });
  if (duplicates.length) checks.push({ id: 'path.duplicates', status: 'info', title: `${duplicates.length} repeated PATH ${duplicates.length === 1 ? 'entry' : 'entries'}`,
    detail: 'These directories occur earlier in PATH. Repetition alone does not prove a tool conflict.',
    evidence: evidence(duplicates.map((entry) => entry.path)) });
  if (missing.length) checks.push({ id: 'path.missing', status: 'info', title: `${missing.length} PATH ${missing.length === 1 ? 'entry is' : 'entries are'} unavailable as directories`,
    detail: 'These paths are missing or are files. Removed installations and disconnected drives can leave entries behind.',
    evidence: evidence(missing.map((entry) => entry.path)), remedy: 'Remove stale entries after confirming the associated installation or drive is no longer needed.' });
  if (unreadable.length || invalid.length || truncated || timedOut) checks.push({ id: 'path.incomplete', status: 'warn', title: 'PATH inspection is incomplete',
    detail: `${unreadable.length} uninspected or inaccessible entries; ${invalid.length} malformed or unresolved entries.${truncated ? ` The ${MAX_PATH_ENTRIES}-entry or ${MAX_PATH_LENGTH}-character safety limit was reached.` : ''}${timedOut ? ' The filesystem I/O deadline was reached.' : ''}`,
    evidence: evidence([...unreadable, ...invalid].map((entry) => entry.raw)),
    remedy: 'Review the listed entries and shorten an unusually large PATH before repeating the check.' });
  if (!checks.length) checks.push({ id: 'path.clean', status: 'pass', title: 'PATH contains existing absolute directories without duplicates',
    detail: `${entries.length} entries were inspected. This does not prove that every installation is the intended one.` });
  return { checks, entries, truncated: truncated || timedOut, timedOut };
}

export function validCommandName(name) {
  return typeof name === 'string' && name.length > 0 && name.length <= 255
    && name !== '.' && name !== '..' && !/[\\/\x00-\x1f\x7f]/.test(name);
}

function candidateNames(name, environment, extensions) {
  if (environment.platform === 'win32') {
    const extension = path.win32.extname(name).toLowerCase();
    if (extension) return [{ file: name, eligible: extensions.includes(extension) }];
    return [...extensions.map((suffix) => ({ file: `${name}${suffix}`, eligible: true })),
      { file: name, eligible: false },
      ...(!extensions.includes('.ps1') ? [{ file: `${name}.ps1`, eligible: false }] : [])];
  }
  const result = [{ file: name, eligible: true }];
  if (environment.isWSL && !path.posix.extname(name)) {
    for (const suffix of ['.exe', '.cmd', '.bat']) result.push({ file: `${name}${suffix}`, eligible: false });
  }
  return result;
}

function fileKind(filePath, symbolic) {
  if (symbolic) return 'symlink';
  if (/\.ps1$/i.test(filePath)) return 'powershell-script';
  if (/[\\/]shims[\\/]/i.test(filePath)) return 'shim';
  if (/\.exe$|\.com$/i.test(filePath)) return 'windows-executable';
  if (/\.(?:cmd|bat)$/i.test(filePath)) return 'windows-script';
  return 'file';
}

async function inspectCandidate(filePath, spec, entry, environment, io) {
  const shellMetadata = environment.platform === 'win32' && /\.ps1$/i.test(filePath) ? { shellDependent: true } : {};
  let link;
  try { link = await io.lstat(filePath); } catch (error) {
    return absent(error) ? { missing: true } : { error: code(error) };
  }
  const symbolic = link.isSymbolicLink();
  let target = link;
  let realPath = filePath;
  if (symbolic) {
    try {
      target = await io.stat(filePath);
      realPath = await io.realpath(filePath);
    } catch (error) {
      if (code(error) === 'ETIMEDOUT') return { error: code(error) };
      return { candidate: { path: filePath, realPath: null, kind: 'symlink', executable: false, matchesName: spec.eligible, pathIndex: entry.index,
        ...shellMetadata, reason: `Target unavailable (${code(error)})` } };
    }
  } else if (target.isFile()) {
    // Parent directories may themselves be symlinks (for example /bin ->
    // /usr/bin), even when the final directory entry is a regular file.
    try { realPath = await io.realpath(filePath); } catch { realPath = null; }
  }
  if (!target.isFile()) return { missing: true };
  let executable = environment.platform === 'win32' ? spec.eligible : Boolean(target.mode & 0o111);
  let reason;
  if (environment.platform !== 'win32' && executable) {
    try { await io.access(filePath, constants.X_OK); } catch (error) {
      if (code(error) === 'ETIMEDOUT') return { error: code(error) };
      executable = false;
      reason = `Execute access unavailable (${code(error)})`;
    }
  }
  if (!executable && !reason) reason = environment.platform === 'win32'
    ? shellMetadata.shellDependent ? 'PowerShell script outside PATHEXT; shell selection is not modeled' : 'Extension is not executable under PATHEXT'
    : 'No POSIX execute permission';
  return { candidate: { path: filePath, realPath, kind: fileKind(filePath, symbolic), executable,
    matchesName: spec.eligible, pathIndex: entry.index, ...shellMetadata, ...(reason ? { reason } : {}) } };
}

async function windowsMatches(directory, wanted, io, budget) {
  const matches = new Map();
  let handle;
  try {
    handle = await io.opendir(directory);
    let count = 0;
    while (count < MAX_DIRECTORY_ENTRIES && budget.remaining > 0) {
      const entry = await handle.read();
      if (entry === null) return { matches, complete: true };
      count += 1;
      budget.remaining -= 1;
      const key = entry.name.toLowerCase();
      if (wanted.has(key) && !matches.has(key)) matches.set(key, entry.name);
    }
    return { matches, complete: false, limit: true };
  } catch (error) {
    return { matches, complete: absent(error), ...(absent(error) ? {} : { error: code(error) }) };
  } finally {
    if (handle) {
      try { await handle.close(); } catch { /* The directory may have been closed by an I/O failure. */ }
    }
  }
}

function isRuntime(name) {
  const base = name.toLowerCase().replace(/\.(?:exe|com|cmd|bat)$/, '');
  return /^(?:python(?:\d+(?:\.\d+)*)?|pip\d*)$/.test(base)
    || ['git', 'node', 'nodejs', 'npm', 'npx', 'pnpm', 'yarn', 'bun', 'deno', 'uv', 'go', 'cargo', 'rustc', 'rustup', 'java', 'javac', 'ruby', 'php', 'dotnet', 'cmake', 'gcc', 'clang', 'make'].includes(base);
}

export async function inspectCommands(names, environment, options = {}) {
  const budget = createIoBudget(options);
  const io = boundedIo(environment, budget);
  const requested = Array.isArray(names) ? names : [];
  const invalid = requested.filter((name) => !validCommandName(name));
  const unique = [...new Map(requested.filter(validCommandName).map((name) => [environment.platform === 'win32' ? name.toLowerCase() : name, name])).values()];
  const { entries, truncated: pathTruncated } = getEntries(environment);
  const commandTruncated = unique.length > MAX_COMMANDS;
  const extensions = parsePathExt(environment.pathExt);
  const extensionTruncated = environment.platform === 'win32' && typeof environment.pathExt === 'string'
    && (environment.pathExt.length > 8192 || environment.pathExt.split(';').length > 32);
  const commands = unique.slice(0, MAX_COMMANDS).map((name) => ({ name, selected: null, candidates: [], observedFirst: null,
    complete: !pathTruncated && !extensionTruncated, note: PATH_NOTE,
    specs: candidateNames(name, environment, extensions), uncertainBefore: false }));
  const wanted = new Set(commands.flatMap((command) => command.specs.map((spec) => spec.file.toLowerCase())));
  const directoryBudget = { remaining: MAX_TOTAL_DIRECTORY_ENTRIES };
  let lookups = 0;
  let limitsReached = pathTruncated || commandTruncated || extensionTruncated;
  const inaccessible = new Set();
  const pathApi = environment.platform === 'win32' ? path.win32 : path.posix;
  for (const entry of entries) {
    if (budget.expired) {
      for (const command of commands) command.complete = false;
      break;
    }
    if (entry.duplicateOf !== null) continue;
    if (entry.path === null) {
      if (entry.invalid || entry.driveRelative) {
        inaccessible.add(entry.raw);
        for (const command of commands) { command.complete = false; command.uncertainBefore = true; }
      }
      continue;
    }
    let listing;
    if (environment.platform === 'win32') {
      listing = await windowsMatches(entry.path, wanted, io, directoryBudget);
      if (!listing.complete) {
        if (listing.limit) limitsReached = true;
        else inaccessible.add(entry.path);
        for (const command of commands) { command.complete = false; command.uncertainBefore = true; }
      }
    }
    for (const command of commands) {
      for (const spec of command.specs) {
        const file = listing ? listing.matches.get(spec.file.toLowerCase()) : spec.file;
        if (file === undefined) continue;
        if (lookups >= MAX_LOOKUPS) {
          limitsReached = true;
          command.complete = false;
          command.uncertainBefore = true;
          continue;
        }
        lookups += 1;
        const filePath = pathApi.join(entry.path, file);
        const result = await inspectCandidate(filePath, spec, entry, environment, io);
        if (result.error) {
          inaccessible.add(filePath);
          command.complete = false;
          command.uncertainBefore = true;
        }
        const candidate = result.candidate;
        if (!candidate) continue;
        command.candidates.push(candidate);
        if (candidate.executable && candidate.matchesName) {
          command.observedFirst ??= candidate.path;
          if (!command.uncertainBefore) command.selected ??= candidate.path;
        }
      }
    }
  }
  const timedOut = budget.timeouts > 0 || budget.expired;
  if (timedOut) for (const command of commands) command.complete = false;
  const checks = [];
  if (invalid.length) checks.push({ id: 'which.invalid-name', status: 'warn', title: 'Some requested command names were not inspected',
    detail: `${invalid.length} names were empty, exceeded 255 characters, or contained a path separator or control character. Supply bare command names.` });
  if (limitsReached || inaccessible.size || timedOut) checks.push({ id: 'which.incomplete', status: 'warn', title: 'Command inspection is incomplete',
    detail: `${inaccessible.size} locations could not be inspected.${limitsReached ? ' A bounded PATH, command, extension, directory, or candidate lookup limit was reached.' : ''}${timedOut ? ' The filesystem I/O deadline was reached.' : ''} An unresolved selection is not proof that a command is absent.`,
    evidence: evidence([...inaccessible]), remedy: 'Review inaccessible locations or inspect fewer command names with a shorter PATH.' });
  const resolved = commands.filter((command) => command.selected);
  if (resolved.length) checks.push({ id: 'which.resolved', status: 'pass', title: `${resolved.length} external ${resolved.length === 1 ? 'command resolves' : 'commands resolve'} through PATH`,
    detail: 'Selection follows PATH order and POSIX execute access, or Windows PATHEXT extension order. This does not execute a runtime or verify its version, architecture, interpreter, or Windows ACL.',
    evidence: evidence(resolved.map((command) => `${command.name}: ${command.selected}`)) });
  const missing = commands.filter((command) => !command.selected && command.complete);
  if (missing.length) checks.push({ id: 'which.missing', status: 'info', title: `${missing.length} requested ${missing.length === 1 ? 'command has' : 'commands have'} no eligible PATH file`,
    detail: 'A missing optional tool is not an environment failure. Aliases, shell functions, and interpreter-specific script lookup can still provide commands.',
    evidence: evidence(missing.map((command) => command.name)), docs: COMMAND_DOCS });
  const multiple = commands.filter((command) => new Set(command.candidates.filter((candidate) => candidate.executable && candidate.matchesName)
    .map((candidate) => normalizeKey(candidate.realPath ?? candidate.path, environment.platform))).size > 1);
  if (multiple.length) checks.push({ id: 'which.multiple', status: 'info', title: `${multiple.length} ${multiple.length === 1 ? 'command has' : 'commands have'} multiple PATH candidates`,
    detail: 'The first eligible candidate wins. Version-manager shims and package-manager wrappers are often intentional; a second candidate does not prove a conflict or a distinct installation.',
    evidence: evidence(multiple.map((command) => `${command.name}: ${command.candidates.filter((candidate) => candidate.executable && candidate.matchesName).length} candidates`)) });
  const nonexecutable = commands.flatMap((command) => command.candidates.filter((candidate) => candidate.matchesName && !candidate.executable).map((candidate) => ({ command, candidate })));
  if (nonexecutable.length) checks.push({ id: 'which.nonexecutable', status: nonexecutable.some(({ command }) => !command.selected) ? 'warn' : 'info',
    title: `${nonexecutable.length} matching ${nonexecutable.length === 1 ? 'file is' : 'files are'} not executable`,
    detail: 'These files were excluded from selection because execute access or a symlink target was unavailable.',
    evidence: evidence(nonexecutable.map(({ candidate }) => candidate.path)), remedy: 'Check the installation or permissions of the intended file before changing PATH.' });
  const windowsLocations = environment.isWSL && !environment.mountInfoTruncated ? resolved.filter((command) => isRuntime(command.name)).flatMap((command) => {
    const realPath = command.candidates.find((candidate) => candidate.path === command.selected)?.realPath;
    if (typeof realPath !== 'string') return [];
    const location = classifyFilesystem(realPath, environment);
    return location.kind === 'windows' && location.source === 'mount' && location.confidence === 'confirmed'
      ? [{ command, realPath, location }] : [];
  }) : [];
  if (windowsLocations.length) checks.push({ id: 'which.windows-filesystem', status: 'warn', title: 'Selected development tools are stored on a Windows filesystem',
    detail: 'Mount metadata places these selected tool files on a Windows filesystem. Location alone does not establish the interpreter or runtime architecture of a wrapper.',
    evidence: evidence(windowsLocations.map(({ command, realPath, location }) => `${command.name}: ${realPath} (${location.filesystem})`)),
    remedy: 'Review which installation supplies the selected file. Use a Linux-side installation when a Linux toolchain is intended, or keep the path when this filesystem boundary is intentional.',
    docs: 'https://learn.microsoft.com/en-us/windows/wsl/filesystems' });
  const windowsRuntime = environment.isWSL ? resolved.filter((command) => isRuntime(command.name)
    && /\.(?:exe|com|cmd|bat)$/i.test(command.candidates.find((candidate) => candidate.path === command.selected)?.realPath ?? command.selected)) : [];
  if (windowsRuntime.length) checks.push({ id: 'which.windows-runtime', status: 'warn', title: 'A Windows runtime file is selected inside WSL',
    detail: 'This may be intentional interop. Windows runtimes use Windows paths and platform-specific dependencies; confirm that the project expects this boundary. File type is inferred from the extension, and executability is not tested.',
    evidence: evidence(windowsRuntime.map((command) => `${command.name}: ${command.selected}`)),
    remedy: 'Use a Linux runtime installation for a Linux toolchain, or explicitly use Windows interop for a Windows toolchain. Windows batch files require a Windows command interpreter.',
    docs: 'https://learn.microsoft.com/en-us/windows/wsl/filesystems#run-windows-tools-from-linux' });
  const powershellScripts = commands.flatMap((command) => command.candidates.filter((candidate) => candidate.shellDependent)
    .map((candidate) => ({ command, candidate })));
  if (powershellScripts.length) checks.push({ id: 'which.powershell-script', status: 'info', title: 'PowerShell scripts can affect command selection',
    detail: 'PowerShell recognizes .ps1 scripts independently of PATHEXT and may choose one instead of the selected PATHEXT candidate. The current shell session, execution policy, ACLs, and script validity were not inspected.',
    evidence: evidence(powershellScripts.map(({ command, candidate }) => `${command.name}: ${candidate.path}${candidate.matchesName ? '' : ' (outside PATHEXT)'}`)),
    remedy: 'Run Get-Command <name> -All in the PowerShell session to inspect its command selection. Review the intended wrapper without changing execution policy automatically.',
    docs: 'https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables#path-information' });
  const nearby = commands.filter((command) => !command.selected && command.candidates.some((candidate) => !candidate.matchesName && !candidate.shellDependent));
  if (nearby.length) checks.push({ id: 'which.nearby', status: 'info', title: 'Related files do not match this platform lookup',
    detail: environment.platform === 'win32' ? 'Extensionless Unix wrappers are not selected by this PATHEXT lookup.' : 'WSL does not append Windows PATHEXT extensions. A file named tool.exe does not make a command named tool available.',
    evidence: evidence(nearby.flatMap((command) => command.candidates.filter((candidate) => !candidate.matchesName && !candidate.shellDependent).map((candidate) => candidate.path))) });
  for (const command of commands) {
    if (environment.platform === 'win32') {
      command.note += ' Windows selection follows the PATH/PATHEXT model.';
      if (command.candidates.some((candidate) => candidate.shellDependent)) {
        const selectedScript = command.candidates.some((candidate) => candidate.path === command.selected && candidate.shellDependent);
        command.note += command.selected
          ? selectedScript ? ' The selected PATHEXT candidate is a PowerShell script.' : ' PowerShell may choose a .ps1 script instead of the selected PATHEXT candidate.'
          : ' PowerShell may resolve the observed .ps1 script even though this PATHEXT model has no selected candidate.';
      }
      command.note += ' PowerShell execution policy, file associations, and Windows ACLs were not inspected.';
    }
    if (!command.complete) command.note += command.selected ? ' The selected file precedes any unresolved PATH candidate; some inspection metadata remains incomplete.' : ' Incomplete inspection prevents a definitive missing-command conclusion.';
    delete command.specs;
    delete command.uncertainBefore;
  }
  return { checks, commands, truncated: limitsReached || timedOut, timedOut };
}
