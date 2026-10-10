import path from 'node:path';

export class PathError extends Error {
  constructor(message) { super(message); this.name = 'PathError'; }
}

function validateText(value, label) {
  if (typeof value !== 'string' || !value || value.length > 16384 || /[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value)) {
    throw new PathError(`${label} must be nonempty, under 16 KiB, and contain no control characters.`);
  }
}

function mountRoot(value) {
  validateText(value, 'Mount root');
  if (!value.startsWith('/') || value.startsWith('//') || value.includes('\\')) {
    throw new PathError('Mount root must be an absolute Linux path, such as /mnt or /windows.');
  }
  return path.posix.normalize(value).replace(/\/$/u, '') || '';
}

function distroName(value) {
  if (!value || !/^[\p{L}\p{N}][\p{L}\p{N}_. -]{0,127}$/u.test(value) || /[. ]$/u.test(value)) {
    throw new PathError('A valid --distro name is required for a Linux filesystem path (for example, --distro Ubuntu).');
  }
  return value;
}

function winCompatible(parts) {
  for (const part of parts) {
    if (/[<>:"|?*]/u.test(part) || /[. ]$/u.test(part) || /^(?:CON|PRN|AUX|NUL|COM[1-9¹²³]|LPT[1-9¹²³])(?:\.|$)/iu.test(part)) {
      throw new PathError('This path contains a name that cannot be represented safely on a Windows drive.');
    }
  }
}

function linuxAbsolute(input) {
  if (!input.startsWith('/') || input.startsWith('//') || input.includes('\\')) {
    throw new PathError('Use an absolute Linux path. Backslashes, relative paths, and // paths are ambiguous.');
  }
  return path.posix.normalize(input);
}

/** Pure lexical mapping. Does not assert that the drive, distribution, or path exists. */
export function convertPath(input, options = {}) {
  validateText(input, 'Path');
  const root = mountRoot(options.mountRoot ?? '/mnt');
  const to = options.to ?? (/^[a-zA-Z]:[\\/]/u.test(input) || /^[\\/]{2}/u.test(input) ? 'wsl' : 'windows');
  if (!['windows', 'wsl'].includes(to)) throw new PathError('--to must be windows or wsl.');
  const windowsInput = input.replaceAll('/', '\\');
  if (to === 'wsl') {
    // Device namespaces, network shares, and drive-relative paths require a real mount map.
    if (/^\\\\(?:\?\?|[?.])\\/u.test(windowsInput)) {
      throw new PathError('Windows device/extended-length namespaces are not supported; use a normal absolute drive or WSL UNC path.');
    }
    const unc = /^\\\\(?:wsl\$|wsl\.localhost)\\([^\\]+)(\\.*)?$/iu.exec(windowsInput);
    if (unc) {
      const sourceDistro = distroName(unc[1]);
      if (options.distro && sourceDistro.toLowerCase() !== distroName(options.distro).toLowerCase()) {
        throw new PathError('The UNC distribution differs from --distro; refusing a cross-distribution mapping.');
      }
      return path.posix.normalize((unc[2] ?? '/').replaceAll('\\', '/'));
    }
    if (/^[a-zA-Z]:[\\/]/u.test(input)) {
      const normalized = path.win32.normalize(windowsInput);
      const drive = normalized[0].toLowerCase();
      const tail = normalized.slice(3).replaceAll('\\', '/').replace(/\/$/u, '');
      winCompatible(tail ? tail.split('/') : []);
      return `${root}/${drive}${tail ? '/' + tail : ''}`;
    }
    if (input.startsWith('/') && !input.startsWith('//')) return linuxAbsolute(input);
    throw new PathError('Use C:\\absolute\\path or \\\\wsl.localhost\\Distro\\path. Other UNC shares and drive-relative paths require an explicit mount.');
  }
  if (/^[a-zA-Z]:[\\/]/u.test(input)) {
    const normalized = path.win32.normalize(windowsInput);
    winCompatible(normalized.slice(3).split('\\').filter(Boolean));
    return normalized[0].toUpperCase() + normalized.slice(1);
  }
  const normalized = linuxAbsolute(input);
  const relative = root ? (normalized.startsWith(root + '/') ? normalized.slice(root.length + 1) : null) : normalized.slice(1);
  if (relative && /^[a-zA-Z](?:\/|$)/u.test(relative)) {
    const drive = relative[0].toUpperCase();
    const tail = relative.slice(2);
    winCompatible(tail ? tail.split('/') : []);
    return `${drive}:\\${tail.replaceAll('/', '\\')}`;
  }
  const distro = distroName(options.distro);
  // WSL's UNC provider exposes Linux names; Linux data need not obey NTFS naming rules.
  return `\\\\wsl.localhost\\${distro}${normalized === '/' ? '\\' : normalized.replaceAll('/', '\\')}`;
}

export function quotePath(value, shell) {
  validateText(value, 'Path');
  if (shell === 'bash') return "'" + value.replaceAll("'", "'\\''") + "'";
  // PowerShell's IsSingleQuote includes typographic apostrophes U+2018–201B.
  if (shell === 'powershell') return "'" + value.replace(/['\u2018-\u201b]/gu, character => character + character) + "'";
  throw new PathError('--quote must be bash or powershell.');
}
