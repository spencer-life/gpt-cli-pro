import test from 'node:test';
import assert from 'node:assert/strict';
import { stat } from 'node:fs/promises';
import { createServer } from 'node:net';
import path from 'node:path';
import { inspectPorts } from '../src/ports.mjs';
import { runSystem } from '../src/process.mjs';
import { cleanText } from '../src/report.mjs';

const nativePlatform = ['win32', 'darwin'].includes(process.platform);

async function expectedCollector() {
  if (process.platform === 'darwin') return 'lsof';
  const executable = path.win32.join(process.env.SystemRoot || 'C:\\Windows',
    'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  try {
    // A present Windows PowerShell must exercise the real query. A fallback to
    // netstat must not conceal a broken script, encoding, or module invocation.
    return (await stat(executable)).isFile() ? 'powershell' : 'netstat';
  } catch (error) {
    if (['ENOENT', 'ENOTDIR'].includes(error.code)) return 'netstat';
    throw error;
  }
}

test('native Windows/macOS collectors find an owned TCP listener without passive connections', {
  skip: nativePlatform ? false : `Requires native Windows or macOS; this host is ${process.platform}. Native Linux coverage is in ports.test.mjs.`,
  timeout: 20000,
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
      const result = await runSystem(name, args, options);
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
    assert.ok(result.listeners.some(listener => listener.address === '127.0.0.1'
      && listener.port === port && listener.pid === process.pid && listener.family === 'IPv4'),
    `The collector must observe this process's listening socket: ${JSON.stringify({ result, subprocesses })}`);
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
