import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { inspectPorts } from '../src/ports.mjs';
import { readWindowsRoot, runSystem } from '../src/process.mjs';
import { cleanText } from '../src/report.mjs';

const nativePlatform = ['win32', 'darwin'].includes(process.platform);

async function expectedCollector() {
  if (process.platform === 'darwin') return 'lsof';
  const systemRoot = readWindowsRoot();
  assert.ok(systemRoot, 'Native Windows coverage requires an independently resolved operating-system directory.');
  const executable = path.win32.join(systemRoot,
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  // Hosted Windows must exercise the real PowerShell query. Neither a broken
  // root bootstrap nor a missing helper can downgrade this assertion to netstat.
  assert.ok((await stat(executable)).isFile(), 'Native Windows coverage requires the operating-system PowerShell executable.');
  return 'powershell';
}

test('native Windows/macOS collectors find an owned TCP listener without passive connections', {
  skip: nativePlatform ? false : `Requires native Windows or macOS; this host is ${process.platform}. Native Linux coverage is in ports.test.mjs.`,
  // This test deliberately performs two independent collector invocations.
  timeout: 30000,
}, async (t) => {
  const source = await expectedCollector();
  let connections = 0;
  let firstConnection;
  const connected = new Promise(resolve => { firstConnection = resolve; });
  const server = createServer(socket => {
    connections += 1;
    socket.destroy();
    firstConnection();
  });
  t.after(async () => {
    if (server.listening) await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ host: '127.0.0.1', port: 0 }, resolve);
  });
  const port = server.address().port;
  const subprocesses = [];
  async function diagnosticRun(name, args, options) {
    const started = performance.now();
    try {
      const observedArgs = [...args];
      if (name === 'powershell') {
        // Fixed test-only stage markers distinguish startup, provider, process
        // lookup, and serialization delays if a hosted machine times out.
        observedArgs[observedArgs.length - 1] = "[Console]::Error.WriteLine('wslens-native: started'); " + args.at(-1)
          .replace('$rows = @(', "[Console]::Error.WriteLine('wslens-native: query'); $rows = @(")
          .replace('$names = @{}', "[Console]::Error.WriteLine('wslens-native: names'); $names = @{}")
          .replace('$result = @(', "[Console]::Error.WriteLine('wslens-native: serialize'); $result = @(");
      }
      const result = await runSystem(name, observedArgs, options);
      subprocesses.push({
        collector: name,
        elapsedMs: Math.round(performance.now() - started),
        timeoutMs: options.timeoutMs,
        ok: result.ok,
        code: result.code,
        error: result.error ?? null,
        unavailable: Boolean(result.unavailable),
        stdoutBytes: Buffer.byteLength(result.stdout ?? ''),
        // These bounded samples appear only in a failed native assertion. They
        // expose provider/encoding failures without logging command lines or env.
        stdoutPreview: cleanText(result.stdout ?? '').slice(0, 512),
        stderr: cleanText(result.stderr ?? '').slice(0, 2048),
      });
      return result;
    } catch (error) {
      subprocesses.push({ collector: name, elapsedMs: Math.round(performance.now() - started),
        timeoutMs: options.timeoutMs, error: cleanText(error.message).slice(0, 512) });
      throw error;
    }
  }
  function verifyInventory(result) {
    assert.equal(result.source, source, `Expected the native ${source} collector: ${JSON.stringify({ checks: result.checks, subprocesses })}`);
    const owned = result.listeners.find(listener => listener.address === '127.0.0.1'
      && listener.port === port && listener.pid === process.pid && listener.family === 'IPv4');
    assert.ok(owned,
    `The collector must observe this process's listening socket: ${JSON.stringify({ result, subprocesses })}`);
    if (source === 'powershell') {
      assert.equal(owned.process?.toLowerCase(), path.parse(process.execPath).name.toLowerCase(),
        `The native collector must resolve its own listener's process name: ${JSON.stringify({ owned, subprocesses })}`);
    }
    if (process.platform === 'darwin') {
      assert.equal(result.checks.find(check => check.id === 'ports.visibility')?.status, 'warn',
        'Finding our own socket does not establish visibility into other users\' sockets.');
    }
  }

  const passive = await inspectPorts({ port, run: diagnosticRun });
  verifyInventory(passive);
  assert.deepEqual(passive.probes, []);
  assert.equal(connections, 0, 'Passive inventory must not connect to the listening server.');

  const active = await inspectPorts({ port, probe: true, run: diagnosticRun });
  verifyInventory(active);
  assert.deepEqual(active.probes.map(probe => probe.address), ['127.0.0.1', '::1']);
  assert.ok(active.probes.every(probe => probe.port === port));
  assert.equal(active.probes.find(probe => probe.address === '127.0.0.1')?.status, 'reachable');
  // Wait for the server's accept event as well as the client's connect event;
  // their scheduling order can differ between native networking backends.
  await connected;
  assert.equal(connections, 1, 'Only the explicit IPv4 probe should connect to this IPv4 listener.');
});
