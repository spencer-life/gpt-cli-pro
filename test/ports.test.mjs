import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { readlink } from 'node:fs/promises';
import {
  decodeProcAddress,
  inspectPorts,
  inspectProcListeners,
  parseLsofListeners,
  parsePowerShellListeners,
  parseProcNetTcp,
  parseWindowsNetstat,
} from '../src/ports.mjs';

const HEADER = '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt uid timeout inode';
const HEADER6 = HEADER.replace('rem_address', 'remote_address');
const procRow = (address, port = '0BB8', state = '0A', inode = '12345') => `   0: ${address}:${port} 00000000:0000 ${state} 00000000:00000000 00:00000000 00000000 1000 0 ${inode} 1 0000000000000000`;
const WIN_HEADER = 'Active Connections\r\n\r\n  Proto  Local Address          Foreign Address        State           PID\r\n';
const row = { LocalAddress: '127.0.0.1', LocalPort: 3000, OwningProcess: 123, ProcessName: 'node' };
const noOwners = async () => new Map();

test('proc address decoding reverses bytes per word, including non-loopback IPv6', () => {
  assert.equal(decodeProcAddress('0100007F', 'IPv4', 'LE'), '127.0.0.1');
  assert.equal(decodeProcAddress('7F000001', 'IPv4', 'BE'), '127.0.0.1');
  assert.equal(decodeProcAddress('00000000000000000000000001000000', 'IPv6', 'LE'), '::1');
  assert.equal(decodeProcAddress('B80D01200000000067452301EFCDAB89', 'IPv6', 'LE'), '2001:db8::123:4567:89ab:cdef');
  assert.equal(decodeProcAddress('20010DB8000000000123456789ABCDEF', 'IPv6', 'BE'), '2001:db8::123:4567:89ab:cdef');
  assert.equal(decodeProcAddress('00000000000000000000000000000000', 'IPv6', 'LE'), '::');
  assert.equal(decodeProcAddress('not an address', 'IPv4', 'LE'), null);
});

test('proc tables include only LISTEN entries and preserve large inode values as strings', () => {
  const parsed = parseProcNetTcp(`${HEADER}\n${procRow('0100007F', '0BB8', '0A', '18446744073709551615')}\n${procRow('00000000', '01BB', '01')}\n`, 'IPv4', 'LE');
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.malformed, 0);
  assert.equal(parsed.listeners.length, 1);
  assert.deepEqual(parsed.listeners[0], { address: '127.0.0.1', port: 3000, pid: null, process: null, family: 'IPv4', inode: '18446744073709551615' });
  const ipv6 = parseProcNetTcp(`${HEADER6}\n${procRow('00000000000000000000000001000000')}`, 'IPv6', 'LE');
  assert.equal(ipv6.listeners[0].address, '::1');
  assert.equal(ipv6.recognized, true);
});

test('malformed proc rows and missing headers cannot create a clean inventory', () => {
  assert.equal(parseProcNetTcp('').recognized, false);
  const parsed = parseProcNetTcp(`${HEADER}\n${procRow('ZZ00007F')}\n${procRow('0100007F', '0000')}\nnot a row`, 'IPv4', 'LE');
  assert.equal(parsed.malformed, 3);
  assert.equal(parsed.listeners.length, 0);
});

test('PowerShell JSON supports CRLF, BOM, singleton, arrays, and empty values', () => {
  const single = parsePowerShellListeners(`\uFEFF${JSON.stringify(row)}\r\n`);
  assert.equal(single.recognized, true);
  assert.deepEqual(single.listeners[0], { address: '127.0.0.1', port: 3000, pid: 123, process: 'node', family: 'IPv4' });
  const multiple = parsePowerShellListeners(JSON.stringify([row, { ...row, LocalAddress: '::', OwningProcess: 0 }]));
  assert.equal(multiple.listeners.length, 2);
  assert.equal(multiple.listeners[1].family, 'IPv6');
  assert.equal(multiple.listeners[1].pid, 0);
  for (const empty of ['[]', 'null']) {
    assert.equal(parsePowerShellListeners(empty).recognized, true);
    assert.equal(parsePowerShellListeners(empty).listeners.length, 0);
  }
});

test('PowerShell parser validates untrusted numbers and retains hostile process names as data', () => {
  const hostileName = 'node; $(touch /tmp/should-never-exist)\u001b[31m\n`id`';
  const parsed = parsePowerShellListeners(JSON.stringify([
    { ...row, ProcessName: hostileName },
    { ...row, LocalPort: { toString: null, valueOf: null } },
    { ...row, OwningProcess: -1 },
    { ...row, LocalAddress: 'example.com' },
    { ...row, State: 'Established' },
    null,
  ]));
  assert.equal(parsed.listeners.length, 1);
  assert.equal(parsed.listeners[0].process, hostileName);
  assert.equal(parsed.malformed, 5);
  assert.equal(parsePowerShellListeners('{partial').recognized, false);
  assert.equal(parsePowerShellListeners('"unexpected scalar"').recognized, false);
});

test('Windows netstat reads IPv4/IPv6 CRLF output and ignores established sockets and UDP', () => {
  const parsed = parseWindowsNetstat(`${WIN_HEADER}  TCP    0.0.0.0:3000    0.0.0.0:0       LISTENING       900\r\n  TCP    [::1]:3001    [::]:0       LISTENING       901\r\n  TCP    127.0.0.1:50123  127.0.0.1:3000 ESTABLISHED 902\r\n  UDP    0.0.0.0:5353 *:* 903\r\n`);
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.malformed, 0);
  assert.deepEqual(parsed.listeners.map(listener => [listener.address, listener.port, listener.pid, listener.family]), [
    ['0.0.0.0', 3000, 900, 'IPv4'], ['::1', 3001, 901, 'IPv6'],
  ]);
});

test('unknown netstat state labels and malformed listener rows mark coverage incomplete', () => {
  const parsed = parseWindowsNetstat(`${WIN_HEADER}  TCP 127.0.0.1:3000 0.0.0.0:0 ÉCOUTE 99\r\n  TCP hostname:3001 0.0.0.0:0 LISTENING 99\r\n  TCP 127.0.0.1:3002 0.0.0.0:0 LISTENING invalid\r\n`);
  assert.equal(parsed.listeners.length, 0);
  assert.equal(parsed.malformed, 3);
  assert.equal(parseWindowsNetstat('access denied').recognized, false);
});

test('lsof NUL fields keep whitespace and shell syntax in names separate from records', () => {
  const name = 'odd name\n$(echo bad)\u001b[31m';
  const parsed = parseLsofListeners(`p123\0c${name}\0\nf20\0tIPv4\0n*:3000\0TST=LISTEN\0\nf21\0tIPv6\0n[::1]:3001\0TST=LISTEN\0\np456\0cother\0\nf10\0tIPv4\0n127.0.0.1:9000\0TST=ESTABLISHED\0\n`);
  assert.equal(parsed.recognized, true);
  assert.equal(parsed.listeners.length, 2);
  assert.equal(parsed.listeners[0].address, '0.0.0.0');
  assert.equal(parsed.listeners[0].process, name);
  assert.equal(parsed.listeners[1].address, '::1');
  assert.equal(parsed.malformed, 1);
});

test('all listener parsers bound input and listener count', () => {
  const excessive = 'x'.repeat(1024 * 1024 + 1);
  for (const parser of [parseProcNetTcp, parsePowerShellListeners, parseWindowsNetstat, parseLsofListeners]) {
    const parsed = parser(excessive);
    assert.equal(parsed.truncated, true);
    assert.equal(parsed.listeners.length, 0);
  }
  const parsed = parsePowerShellListeners(JSON.stringify(Array(4097).fill(row)));
  assert.equal(parsed.listeners.length, 4096);
  assert.equal(parsed.truncated, true);
});

test('proc partial reads retain known listeners and mark missing IPv6 visibility', async () => {
  const readCalls = [];
  const result = await inspectPorts({
    port: 3000,
    environment: { platform: 'linux' },
    procIO: {
      byteOrder: 'LE',
      read: async (path, maxBytes, timeoutMs) => {
        readCalls.push({ path, maxBytes, timeoutMs });
        if (path.endsWith('tcp6')) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
        return { text: `${HEADER}\n${procRow('0100007F')}\n${procRow('00000000', '0FA0')}`, truncated: false };
      },
      owners: async () => new Map([['12345', { pid: 100, process: 'test-owner' }]]),
    },
  });
  assert.equal(result.listeners.length, 1);
  assert.equal(result.listeners[0].pid, 100);
  assert.equal(result.listeners[0].process, 'test-owner');
  assert.equal(Object.hasOwn(result.listeners[0], 'inode'), false);
  assert.equal(result.checks.find(check => check.id === 'ports.visibility').status, 'warn');
  assert.deepEqual(readCalls.map(call => call.path), ['/proc/net/tcp', '/proc/net/tcp6']);
  assert.ok(readCalls.every(call => call.maxBytes === 1024 * 1024 && call.timeoutMs === 1500));
});

test('empty, truncated, unreadable, and successful proc results have distinct coverage', async () => {
  const success = await inspectProcListeners({ read: async path => ({ text: path.endsWith('tcp6') ? HEADER6 : HEADER, truncated: false }), owners: noOwners });
  assert.equal(success.complete, true);
  assert.equal(success.available, true);
  const limited = await inspectPorts({ environment: { platform: 'linux' }, procIO: { read: async () => ({ text: HEADER, truncated: true }), owners: noOwners } });
  assert.equal(limited.checks.find(check => check.id === 'ports.listeners').status, 'skip');
  assert.equal(limited.checks.find(check => check.id === 'ports.visibility').status, 'warn');
  const unavailable = await inspectPorts({ environment: { platform: 'linux' }, procIO: { read: async () => { throw new Error('unreadable'); }, owners: noOwners } });
  assert.equal(unavailable.source, 'unavailable');
  assert.ok(unavailable.checks.every(check => check.status === 'skip'));
});

test('Windows uses fixed PowerShell and never executes a process name', async () => {
  const calls = [];
  const hostileName = 'node; Start-Process calc.exe';
  const result = await inspectPorts({ port: 3000, environment: { platform: 'win32' }, run: async (name, args, options) => {
    calls.push({ name, args, options });
    return { ok: true, code: 0, stdout: JSON.stringify([{ ...row, ProcessName: hostileName }, row, { ...row, LocalPort: 4000 }]), stderr: '' };
  } });
  assert.equal(result.source, 'powershell');
  assert.equal(result.listeners.length, 1);
  assert.equal(result.listeners[0].process, hostileName);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].name, 'powershell');
  assert.deepEqual(calls[0].args.slice(0, 4), ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command']);
  assert.doesNotMatch(calls[0].args.at(-1), /Start-Process|calc\.exe|3000/);
  assert.match(calls[0].args.at(-1), /Get-NetTCPConnection/);
  assert.match(calls[0].args.at(-1), /PSModulePath/);
  assert.deepEqual(calls[0].options, { platform: 'win32', timeoutMs: 8000, maxBuffer: 1024 * 1024 });
});

test('Windows falls back to both address families with netstat when PowerShell is unavailable', async () => {
  const calls = [];
  const result = await inspectPorts({ environment: { platform: 'win32' }, run: async (name, args, options) => {
    calls.push({ name, args, options });
    if (name === 'powershell') return { ok: false, unavailable: true };
    return { ok: true, code: 0, stdout: `${WIN_HEADER} TCP [::]:3000 [::]:0 LISTENING 123\r\n`, stderr: '' };
  } });
  assert.equal(result.source, 'netstat');
  assert.equal(result.listeners[0].family, 'IPv6');
  assert.equal(calls[0].options.timeoutMs, 8000, 'PowerShell needs a separate cold-start budget.');
  assert.deepEqual(calls[1], { name: 'netstat', args: ['-ano'], options: { platform: 'win32', timeoutMs: 3000, maxBuffer: 1024 * 1024 } });
  assert.equal(result.checks.some(check => check.id === 'ports.visibility'), false);
});

test('incomplete subprocess results retain observations without claiming full visibility', async () => {
  const result = await inspectPorts({ environment: { platform: 'win32' }, run: async name => name === 'powershell'
    ? { ok: false, unavailable: true }
    : { ok: false, code: null, error: 'Output limit reached', stdout: `${WIN_HEADER} TCP 127.0.0.1:3000 0.0.0.0:0 LISTENING 123\r\n`, stderr: '' },
  });
  assert.equal(result.listeners.length, 1);
  assert.equal(result.checks.find(check => check.id === 'ports.visibility').status, 'warn');
  const partialPowerShell = await inspectPorts({ environment: { platform: 'win32' }, run: async name => name === 'powershell'
    ? { ok: false, code: 1, stdout: JSON.stringify(row) }
    : { ok: false, unavailable: true },
  });
  assert.equal(partialPowerShell.source, 'powershell');
  assert.equal(partialPowerShell.listeners.length, 1);
  assert.equal(partialPowerShell.checks.find(check => check.id === 'ports.visibility').status, 'warn');
  const headersOnly = await inspectPorts({ environment: { platform: 'win32' }, run: async name => name === 'powershell'
    ? { ok: false, code: 1, stdout: JSON.stringify(row) }
    : { ok: false, stdout: WIN_HEADER },
  });
  assert.equal(headersOnly.listeners.length, 1);
  assert.equal(headersOnly.source, 'powershell');
});

test('unavailable Windows tools and unsupported platforms skip rather than report clean results', async () => {
  const windows = await inspectPorts({ environment: { platform: 'win32' }, run: async () => { throw new Error('tool unavailable'); } });
  assert.equal(windows.source, 'unavailable');
  assert.ok(windows.checks.every(check => check.status === 'skip'));
  const unknown = await inspectPorts({ environment: { platform: 'aix' } });
  assert.equal(unknown.source, 'unavailable');
  assert.ok(unknown.checks.every(check => check.status === 'skip'));
});

test('macOS lsof results disclose permission limits even when no visible sockets are returned', async () => {
  const calls = [];
  const result = await inspectPorts({ environment: { platform: 'darwin' }, run: async (name, args, options) => {
    calls.push({ name, args, options });
    return { ok: false, code: 1, stdout: '', stderr: '' };
  } });
  assert.equal(result.source, 'lsof');
  assert.equal(result.listeners.length, 0);
  assert.equal(result.checks.find(check => check.id === 'ports.listeners').status, 'skip');
  assert.equal(result.checks.find(check => check.id === 'ports.visibility').status, 'warn');
  assert.deepEqual(calls[0].args, ['-nP', '-a', '-iTCP', '-sTCP:LISTEN', '-FpcftnT0']);
  assert.equal(calls[0].options.platform, 'darwin');
  assert.equal(calls[0].options.timeoutMs, 3000, 'The PowerShell budget must not extend lsof.');
});

test('port filters are strictly numeric and probes require explicit true plus one port', async () => {
  for (const port of [0, -1, 65536, 3.5, '3000', '127.0.0.1:3000', [3000], NaN, Infinity]) {
    await assert.rejects(inspectPorts({ port }), /port must be an integer/);
  }
  const noPort = await inspectPorts({ probe: true, environment: { platform: 'aix' } });
  assert.deepEqual(noPort.probes, []);
  assert.equal(noPort.checks.find(check => check.id === 'ports.probe').status, 'skip');
  const truthyFlag = await inspectPorts({ port: 3000, probe: 'true', environment: { platform: 'aix' } });
  assert.deepEqual(truthyFlag.probes, []);
});

test('native Linux inventory and optional loopback probes observe a real local listener', { skip: process.platform !== 'linux' }, async () => {
  let connections = 0;
  const server = createServer(socket => { connections++; socket.destroy(); });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen({ host: '127.0.0.1', port: 0 }, resolve); });
  try {
    const port = server.address().port;
    const procPid = Number(await readlink('/proc/self'));
    const passive = await inspectPorts({ port });
    assert.equal(passive.source, 'proc');
    assert.ok(passive.listeners.some(listener => listener.address === '127.0.0.1' && listener.port === port && listener.pid === procPid));
    assert.deepEqual(passive.probes, []);
    assert.equal(connections, 0, 'passive inspection must not open a socket');
    const active = await inspectPorts({ port, probe: true });
    assert.deepEqual(active.probes.map(probe => probe.address), ['127.0.0.1', '::1']);
    assert.equal(active.probes[0].status, 'reachable');
    assert.ok(active.probes.every(probe => probe.port === port));
    assert.equal(connections, 1);
    assert.equal(new Set(active.checks.map(check => check.id)).size, active.checks.length);
    assert.ok(active.checks.every(check => check.evidence.length <= 20));
  } finally { await new Promise(resolve => server.close(resolve)); }
});
