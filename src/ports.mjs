import { createReadStream } from 'node:fs';
import { opendir, readlink } from 'node:fs/promises';
import { endianness } from 'node:os';
import { createConnection, isIP } from 'node:net';
import { runSystem } from './process.mjs';

const TABLE_BYTES = 1024 * 1024;
const MAX_LISTENERS = 4096;
const MAX_ROWS = 32768;
const IO_TIMEOUT_MS = 1500;
const OWNER_BUDGET_MS = 650;
const PROBE_TIMEOUT_MS = 500;
const DOCS = 'https://learn.microsoft.com/windows/wsl/networking';

function emptyParse() {
  return { listeners: [], malformed: 0, truncated: false, recognized: false };
}

function validPort(value) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,5}$/.test(value) ? Number(value) : NaN;
  return Number.isInteger(numeric) && numeric >= 1 && numeric <= 65535 ? numeric : null;
}

function validPid(value) {
  const numeric = typeof value === 'number' ? value : typeof value === 'string' && /^\d{1,10}$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(numeric) && numeric >= 0 && numeric <= 0xffffffff ? numeric : null;
}

function processName(value) {
  // Keep names as data. The report renderer handles terminal/Markdown escaping.
  return typeof value === 'string' && value.length ? value.slice(0, 160) : null;
}

function numericAddress(address) {
  return typeof address === 'string' && address.length <= 128 && isIP(address) ? address : null;
}

function appendListener(result, listener) {
  if (result.listeners.length >= MAX_LISTENERS) result.truncated = true;
  else result.listeners.push(listener);
}

function compressIPv6(bytes) {
  const words = Array.from({ length: 8 }, (_, index) => bytes.readUInt16BE(index * 2).toString(16));
  let bestStart = -1;
  let bestLength = 1;
  for (let index = 0; index < words.length;) {
    if (words[index] !== '0') { index++; continue; }
    const start = index;
    while (index < words.length && words[index] === '0') index++;
    if (index - start > bestLength) { bestStart = start; bestLength = index - start; }
  }
  if (bestStart < 0) return words.join(':');
  return `${words.slice(0, bestStart).join(':')}::${words.slice(bestStart + bestLength).join(':')}`;
}

/** Linux prints each address word in host byte order, including IPv6's four words. */
export function decodeProcAddress(hex, family = 'IPv4', byteOrder = endianness()) {
  const width = family === 'IPv4' ? 8 : family === 'IPv6' ? 32 : 0;
  if (!width || hex.length !== width || !/^[0-9a-f]+$/i.test(hex) || !['LE', 'BE'].includes(byteOrder)) return null;
  const bytes = Buffer.from(hex, 'hex');
  if (byteOrder === 'LE') {
    for (let index = 0; index < bytes.length; index += 4) bytes.subarray(index, index + 4).reverse();
  }
  return family === 'IPv4' ? [...bytes].join('.') : compressIPv6(bytes);
}

/** Parse LISTEN entries only; inode is internal metadata for best-effort ownership. */
export function parseProcNetTcp(text, family = 'IPv4', byteOrder = endianness()) {
  const result = emptyParse();
  if (typeof text !== 'string' || text.length > TABLE_BYTES) return { ...result, truncated: true };
  const lines = text.split(/\r?\n/);
  result.recognized = /^\s*sl\s+local_address\s+rem(?:ote)?_address\s+st\b/.test(lines[0] ?? '');
  if (!result.recognized) result.malformed++;
  for (let index = result.recognized ? 1 : 0; index < lines.length; index++) {
    if (index > MAX_ROWS) { result.truncated = true; break; }
    const line = lines[index].trim();
    if (!line) continue;
    const parts = line.split(/\s+/);
    if (parts.length < 10 || !/^\d+:$/.test(parts[0]) || !/^[\da-f]{2}$/i.test(parts[3])) { result.malformed++; continue; }
    if (parts[3].toUpperCase() !== '0A') continue;
    const endpoint = /^([\da-f]+):([\da-f]{4})$/i.exec(parts[1]);
    const address = endpoint ? decodeProcAddress(endpoint[1], family, byteOrder) : null;
    const port = endpoint ? validPort(Number.parseInt(endpoint[2], 16)) : null;
    if (!address || !port || !/^\d{1,24}$/.test(parts[9])) { result.malformed++; continue; }
    appendListener(result, { address, port, pid: null, process: null, family, inode: parts[9] });
  }
  return result;
}

/** PowerShell can emit a JSON singleton or array depending on how it was invoked. */
export function parsePowerShellListeners(text) {
  const result = emptyParse();
  if (typeof text !== 'string' || text.length > TABLE_BYTES) return { ...result, truncated: true };
  let data;
  try { data = JSON.parse(text.replace(/^\uFEFF/, '').trim()); }
  catch { return { ...result, malformed: 1 }; }
  if (data === null) return { ...result, recognized: true };
  if (!Array.isArray(data) && (!data || typeof data !== 'object')) return { ...result, malformed: 1 };
  result.recognized = true;
  const rows = Array.isArray(data) ? data : [data];
  for (const row of rows.slice(0, MAX_LISTENERS + 1)) {
    const address = numericAddress(row?.LocalAddress);
    const port = validPort(row?.LocalPort);
    const pid = validPid(row?.OwningProcess);
    if (!address || !port || pid === null || (row.State !== undefined && !['Listen', 'LISTEN', 2].includes(row.State))) {
      result.malformed++;
      continue;
    }
    appendListener(result, { address, port, pid, process: processName(row.ProcessName), family: isIP(address) === 4 ? 'IPv4' : 'IPv6' });
  }
  if (rows.length > MAX_LISTENERS) result.truncated = true;
  return result;
}

function parseEndpoint(value, hintedFamily) {
  const match = /^(?:\[([^\]]+)\]|(.+)):(\d{1,5})$/.exec(value);
  if (!match) return null;
  let address = match[1] ?? match[2];
  if (address === '*') address = hintedFamily === 'IPv6' ? '::' : hintedFamily === 'IPv4' ? '0.0.0.0' : address;
  const port = validPort(match[3]);
  if (!numericAddress(address) || !port) return null;
  return { address, port, family: isIP(address) === 4 ? 'IPv4' : 'IPv6' };
}

const NETSTAT_STATES = new Set(['CLOSED', 'SYN_SENT', 'SYN_RECEIVED', 'ESTABLISHED', 'FIN_WAIT_1', 'FIN_WAIT_2', 'CLOSE_WAIT', 'CLOSING', 'LAST_ACK', 'TIME_WAIT', 'DELETE_TCB', 'BOUND']);

/** netstat fallback deliberately refuses to interpret unknown/localized TCP states. */
export function parseWindowsNetstat(text) {
  const result = emptyParse();
  if (typeof text !== 'string' || text.length > TABLE_BYTES) return { ...result, truncated: true };
  const lines = text.split(/\r?\n/);
  result.recognized = /\bProto\b[\s\S]*\bPID\b/i.test(text);
  for (let index = 0; index < lines.length; index++) {
    if (index >= MAX_ROWS) { result.truncated = true; break; }
    const parts = lines[index].trim().split(/\s+/);
    if (parts[0] !== 'TCP') continue;
    result.recognized = true;
    if (parts.length !== 5) { result.malformed++; continue; }
    if (NETSTAT_STATES.has(parts[3])) continue;
    if (parts[3] !== 'LISTENING') { result.malformed++; continue; }
    const endpoint = parseEndpoint(parts[1]);
    const pid = validPid(parts[4]);
    if (!endpoint || pid === null) { result.malformed++; continue; }
    appendListener(result, { ...endpoint, pid, process: null });
  }
  if (!result.recognized) result.malformed++;
  return result;
}

/** Parse lsof's NUL-delimited fields so whitespace in process names stays data. */
export function parseLsofListeners(text) {
  const result = emptyParse();
  if (typeof text !== 'string' || text.length > TABLE_BYTES) return { ...result, truncated: true };
  let pid = null;
  let name = null;
  let file = null;
  function flush() {
    if (!file) return;
    const endpoint = parseEndpoint(file.name ?? '', file.family);
    if (pid === null || !endpoint || (file.state && file.state !== 'LISTEN')) result.malformed++;
    else appendListener(result, { ...endpoint, pid, process: name });
    file = null;
  }
  const fields = text.split('\0');
  for (let index = 0; index < fields.length; index++) {
    if (index >= MAX_ROWS) { result.truncated = true; break; }
    const field = fields[index].replace(/^\n/, '');
    const value = field.slice(1);
    if (!field) continue;
    if (field[0] === 'p') { flush(); pid = validPid(value); name = null; result.recognized = true; }
    else if (field[0] === 'c') name = processName(value);
    else if (field[0] === 'f') { flush(); file = {}; }
    else if (field[0] === 't' && file) file.family = value;
    else if (field[0] === 'n' && file) file.name = value;
    else if (field.startsWith('TST=') && file) file.state = field.slice(4);
  }
  flush();
  if (!result.recognized && text.trim()) result.malformed++;
  return result;
}

function readBoundedText(path, maxBytes, timeoutMs = IO_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let bytes = 0;
    let settled = false;
    const stream = createReadStream(path, { highWaterMark: Math.min(maxBytes + 1, 64 * 1024) });
    const timer = setTimeout(() => finish(Object.assign(new Error('Read timed out'), { code: 'ETIMEDOUT' })), timeoutMs);
    function finish(error, truncated = false) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stream.destroy();
      if (error) reject(error);
      else resolve({ text: Buffer.concat(chunks).toString('utf8'), truncated });
    }
    stream.on('data', chunk => {
      const room = maxBytes - bytes;
      chunks.push(chunk.subarray(0, Math.max(room, 0)));
      bytes += chunk.length;
      if (bytes > maxBytes) finish(null, true);
    });
    stream.once('error', error => finish(error));
    stream.once('end', () => finish(null));
  });
}

async function findProcOwners(listeners) {
  const wanted = new Set(listeners.map(listener => listener.inode).filter(inode => inode !== '0'));
  if (!wanted.size) return new Map();
  const deadline = Date.now() + OWNER_BUDGET_MS;
  const owners = new Map();
  let descriptors = 0;
  async function inspectPid(pid) {
    let directory;
    const found = [];
    try {
      directory = await opendir(`/proc/${pid}/fd`, { bufferSize: 32 });
      for await (const entry of directory) {
        if (Date.now() >= deadline || descriptors++ >= 4096) break;
        if (!/^\d+$/.test(entry.name)) continue;
        let target;
        try { target = await readlink(`/proc/${pid}/fd/${entry.name}`); }
        catch { continue; }
        const inode = /^socket:\[(\d+)\]$/.exec(target)?.[1];
        if (inode && wanted.has(inode) && !owners.has(inode)) found.push(inode);
      }
    } catch { /* Permissions and process exit make ownership best effort. */ }
    finally { if (directory) await directory.close().catch(() => {}); }
    if (!found.length || Date.now() >= deadline) return;
    let name = null;
    try {
      const result = await readBoundedText(`/proc/${pid}/comm`, 160, Math.max(1, deadline - Date.now()));
      name = processName(result.text.replace(/\n$/, ''));
    } catch { /* A verified PID is still useful without its short name. */ }
    for (const inode of found) owners.set(inode, { pid: Number(pid), process: name });
  }
  async function scan() {
    // A procfs mounted from another PID namespace can expose a different self PID.
    let selfPid = process.pid;
    try { selfPid = validPid(await readlink('/proc/self')) ?? selfPid; } catch { /* Use the runtime PID when procfs cannot identify self. */ }
    await inspectPid(selfPid);
    if (owners.size === wanted.size || Date.now() >= deadline) return owners;
    let directory;
    let processes = 0;
    try {
      directory = await opendir('/proc', { bufferSize: 32 });
      for await (const entry of directory) {
        if (Date.now() >= deadline || processes >= 256 || descriptors >= 4096 || owners.size === wanted.size) break;
        if (!/^\d{1,10}$/.test(entry.name) || Number(entry.name) === selfPid) continue;
        processes++;
        await inspectPid(entry.name);
      }
    } catch { /* Keep any verified ownership gathered before access was denied. */ }
    finally { if (directory) await directory.close().catch(() => {}); }
    return owners;
  }
  let timer;
  try {
    // An outstanding kernel read may finish later; deadline checks end the scan.
    // Return a copy at the deadline so the result cannot mutate after reporting.
    return await Promise.race([scan(), new Promise(resolve => { timer = setTimeout(() => resolve(new Map(owners)), OWNER_BUDGET_MS); })]);
  } finally { clearTimeout(timer); }
}

function summarizeParse(parsed, label, issues) {
  if (parsed.malformed) issues.push(`${label}: ${parsed.malformed} unrecognized or malformed record(s).`);
  if (parsed.truncated) issues.push(`${label}: inspection limit reached.`);
}

/** The injected read/owners functions support platform fixtures without changing host files. */
export async function inspectProcListeners({ port, read = readBoundedText, owners = findProcOwners, byteOrder = endianness() } = {}) {
  const issues = [];
  const listeners = [];
  let available = false;
  const tables = await Promise.allSettled([
    read('/proc/net/tcp', TABLE_BYTES, IO_TIMEOUT_MS),
    read('/proc/net/tcp6', TABLE_BYTES, IO_TIMEOUT_MS),
  ]);
  for (let index = 0; index < tables.length; index++) {
    const table = tables[index];
    const label = index === 0 ? 'IPv4 table' : 'IPv6 table';
    if (table.status === 'rejected') { issues.push(`${label}: unavailable or unreadable.`); continue; }
    const parsed = parseProcNetTcp(table.value.text, index === 0 ? 'IPv4' : 'IPv6', byteOrder);
    parsed.truncated ||= table.value.truncated;
    available ||= parsed.recognized || parsed.listeners.length > 0;
    summarizeParse(parsed, label, issues);
    listeners.push(...parsed.listeners.filter(listener => port === undefined || listener.port === port));
  }
  let ownership = new Map();
  try { ownership = await owners(listeners); } catch { /* Ownership is optional. */ }
  for (const listener of listeners) {
    const owner = ownership.get(listener.inode);
    if (owner) { listener.pid = validPid(owner.pid); listener.process = processName(owner.process); }
  }
  return { listeners, available, complete: available && issues.length === 0, issues, source: available ? 'proc' : 'unavailable' };
}

// All commands, module paths, and script text are fixed. Only listener addresses,
// numeric PIDs/ports, and short process names cross the process boundary.
const POWERSHELL_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  "$ProgressPreference = 'SilentlyContinue'",
  '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
  "$env:PSModulePath = [System.IO.Path]::Combine($PSHOME, 'Modules')",
  "$rows = @(NetTCPIP\\Get-NetTCPConnection -ErrorAction Stop | Microsoft.PowerShell.Core\\Where-Object { $_.State -eq 'Listen' } | Microsoft.PowerShell.Utility\\Select-Object -First 4097)",
  '$names = @{}',
  'foreach ($item in @(Microsoft.PowerShell.Management\\Get-Process -ErrorAction SilentlyContinue)) { $names[[int]$item.Id] = $item.ProcessName }',
  '$result = @(foreach ($row in $rows) { [pscustomobject]@{ LocalAddress = $row.LocalAddress; LocalPort = [int]$row.LocalPort; OwningProcess = [int]$row.OwningProcess; ProcessName = $names[[int]$row.OwningProcess] } })',
  'Microsoft.PowerShell.Utility\\ConvertTo-Json -InputObject $result -Compress -Depth 3',
].join('; ');

async function boundedRun(run, name, args, platform) {
  try { return await run(name, args, { platform, timeoutMs: 3000, maxBuffer: TABLE_BYTES }); }
  catch { return { ok: false, unavailable: true }; }
}

async function inspectWindows(run) {
  const powershell = await boundedRun(run, 'powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', POWERSHELL_SCRIPT], 'win32');
  const first = parsePowerShellListeners(powershell.stdout ?? '');
  if (powershell.ok && first.recognized && (first.listeners.length || !first.malformed)) {
    const issues = [];
    summarizeParse(first, 'PowerShell', issues);
    return { ...first, available: true, complete: issues.length === 0, issues, source: 'powershell' };
  }
  const netstat = await boundedRun(run, 'netstat', ['-ano'], 'win32');
  const second = parseWindowsNetstat(netstat.stdout ?? '');
  const issues = [];
  summarizeParse(second, 'netstat', issues);
  if (!netstat.ok) issues.push('netstat did not complete successfully.');
  const available = second.recognized || second.listeners.length > 0;
  if ((!available || (!netstat.ok && !second.listeners.length)) && first.listeners.length) {
    const firstIssues = ['PowerShell did not complete successfully and netstat did not yield a complete inventory.'];
    summarizeParse(first, 'PowerShell', firstIssues);
    return { ...first, available: true, complete: false, issues: firstIssues, source: 'powershell' };
  }
  if (!available) issues.push('PowerShell and netstat did not provide a usable listener inventory.');
  return { ...second, available, complete: available && netstat.ok && issues.length === 0, issues, source: available ? 'netstat' : 'unavailable' };
}

async function inspectMac(run) {
  const result = await boundedRun(run, 'lsof', ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-FpcftnT0'], 'darwin');
  const parsed = parseLsofListeners(result.stdout ?? '');
  const noVisibleSockets = result.code === 1 && !result.stdout && !result.stderr && !result.unavailable && !result.error;
  const available = result.ok || parsed.listeners.length > 0 || noVisibleSockets;
  const issues = ['lsof visibility depends on process permissions; other users\' sockets may be hidden.'];
  summarizeParse(parsed, 'lsof', issues);
  if (!result.ok && !noVisibleSockets) issues.push('lsof is unavailable or did not complete successfully.');
  return { ...parsed, available, complete: false, issues, source: available ? 'lsof' : 'unavailable' };
}

function probeLoopback(address, port, family) {
  return new Promise(resolve => {
    let socket;
    let timer;
    let settled = false;
    function finish(status, detail) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket?.destroy();
      resolve({ address, port, family, status, detail });
    }
    timer = setTimeout(() => finish('timeout', 'No TCP connection before the 500 ms deadline.'), PROBE_TIMEOUT_MS);
    try {
      socket = createConnection({ host: address, port, family: family === 'IPv4' ? 4 : 6, autoSelectFamily: false });
      socket.once('connect', () => finish('reachable', 'TCP connection established; no application data sent.'));
      socket.once('error', error => {
        if (error.code === 'ECONNREFUSED') finish('refused', 'The local TCP connection was refused.');
        else if (['EAFNOSUPPORT', 'EPROTONOSUPPORT', 'EADDRNOTAVAIL', 'ENETUNREACH'].includes(error.code)) finish('unavailable', 'This loopback address family is unavailable.');
        else if (error.code === 'ETIMEDOUT') finish('timeout', 'The local TCP connection timed out.');
        else finish('error', 'The local TCP connection could not be completed.');
      });
    } catch { finish('error', 'The local TCP connection could not be started.'); }
  });
}

function listenerChecks(inventory, listeners, port) {
  const target = port === undefined ? '' : ` on port ${port}`;
  const count = listeners.length;
  const checks = [{
    id: 'ports.listeners',
    status: count || inventory.complete ? 'info' : 'skip',
    title: count ? `${count} TCP listener${count === 1 ? '' : 's'} observed${target}` : inventory.complete ? `No TCP listener observed${target}` : `TCP listener inventory is incomplete${target}`,
    detail: 'This is a snapshot of the current network namespace. It does not reserve a port or prove Windows-to-WSL reachability. PID and short process name are best effort; a socket may have more than one owner.',
    evidence: listeners.slice(0, 20).map(listener => `${listener.family === 'IPv6' ? `[${listener.address}]` : listener.address}:${listener.port}${listener.pid === null ? '' : ` PID ${listener.pid}`}${listener.process ? ` (${listener.process})` : ''}`),
    ...(port !== undefined && count ? { remedy: 'If your server cannot bind, inspect the listed application and choose another port or stop that application yourself.' } : {}),
    docs: DOCS,
  }];
  if (!inventory.complete) checks.push({
    id: 'ports.visibility',
    status: inventory.available ? 'warn' : 'skip',
    title: 'Listener visibility is incomplete',
    detail: 'Only successfully parsed observations are shown. An empty result cannot establish that the port is unused.',
    evidence: inventory.issues.slice(0, 8),
    remedy: 'Inspect listeners with your operating system tools in the relevant Windows or WSL environment.',
    docs: DOCS,
  });
  return checks;
}

/** Read-only listener inventory. Probes require an explicit, single numeric port. */
export async function inspectPorts({ port, probe = false, environment, run = runSystem, procIO } = {}) {
  if (port !== undefined && (typeof port !== 'number' || validPort(port) === null)) throw new RangeError('port must be an integer from 1 to 65535');
  const platform = environment?.platform ?? process.platform;
  let inventory;
  if (platform === 'linux') inventory = await inspectProcListeners({ ...procIO, port });
  else if (platform === 'win32') inventory = await inspectWindows(run);
  else if (platform === 'darwin') inventory = await inspectMac(run);
  else inventory = { listeners: [], available: false, complete: false, source: 'unavailable', issues: ['Listener inspection is not supported on this platform.'] };
  const seen = new Set();
  const listeners = inventory.listeners.filter(listener => port === undefined || listener.port === port).filter(listener => {
    const key = `${listener.family}/${listener.address}/${listener.port}/${listener.pid}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map(({ address, port: localPort, pid, process: name, family }) => ({ address, port: localPort, pid, process: name, family }))
    .sort((a, b) => a.port - b.port || a.address.localeCompare(b.address) || (a.pid ?? -1) - (b.pid ?? -1));
  const checks = listenerChecks(inventory, listeners, port);
  let probes = [];
  if (probe === true && port !== undefined) {
    probes = await Promise.all([probeLoopback('127.0.0.1', port, 'IPv4'), probeLoopback('::1', port, 'IPv6')]);
    checks.push({
      id: 'ports.probe',
      status: probes.some(result => ['error', 'timeout'].includes(result.status)) ? 'warn' : 'info',
      title: `Loopback TCP probes on port ${port}`,
      detail: 'These explicit connection attempts stayed within this environment. A successful handshake does not verify application health or connectivity from Windows into WSL.',
      evidence: probes.map(result => `${result.address}: ${result.status}`),
      docs: DOCS,
    });
  } else if (probe === true) checks.push({
    id: 'ports.probe', status: 'skip', title: 'Loopback probes need a single explicit port',
    detail: 'No connections were attempted. Specify one port from 1 to 65535 with --probe.', evidence: [], docs: DOCS,
  });
  return { checks, listeners, probes, source: inventory.source };
}
