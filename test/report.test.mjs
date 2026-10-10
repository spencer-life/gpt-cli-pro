import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { cleanText, redactText, sanitize, makeReport, renderReport, reportExitCode, readSnapshot, compareSnapshots, renderDiff } from '../src/report.mjs';

const environment = { platform: 'linux', arch: 'x64', release: 'test', isWSL: true, wslVersion: 2, home: '/home/ada', secret: 'never-output-this' };
const finding = { id: 'example', status: 'warn', title: 'Example', detail: 'A project finding', evidence: ['/home/ada/work/app/run.sh'], remedy: 'Use LF endings.' };
const report = () => makeReport('doctor', environment, [finding], {}, { root: '/home/ada/work/app' });

test('default reports redact known roots and other OS usernames at boundaries', () => {
  const rendered = renderReport(report(), 'json', { home: environment.home, project: '/home/ada/work/app' });
  assert.ok(rendered.includes('<PROJECT>/run.sh'));
  assert.ok(!rendered.includes('/home/ada'));
  assert.ok(!rendered.includes('never-output-this'));
  assert.equal(redactText('/home/ada2/work', { home: '/home/ada' }), '/home/<USER>/work');
  assert.equal(redactText('C:\\Users\\Ada\\work'), 'C:\\Users\\<USER>\\work');
  assert.equal(redactText('C:\\Users\\Ada Lovelace\\work'), 'C:\\Users\\<USER>\\work');
  assert.equal(redactText("C:\\Users\\Ada O'Neil\\work"), 'C:\\Users\\<USER>\\work');
  assert.equal(redactText('C:\\Users\\Ada\\project\\x', { project: 'c:\\users\\ada\\project' }), '<PROJECT>\\x');
  assert.equal(redactText('C:\\work\\ConfidentialClient\\run.sh', { project: 'C:/work/ConfidentialClient' }), '<PROJECT>\\run.sh');
  assert.equal(redactText('https://user:password@example.org/x'), 'https://<REDACTED>@example.org/x');
});

test('explicit redaction opt-out retains paths but still removes terminal controls', () => {
  const text = renderReport(report(), 'text', { redact: false });
  assert.ok(text.includes('/home/ada/work/app/run.sh'));
  assert.equal(cleanText('\x1b[31mred\x1b[0m\x1b]8;;https://evil.example\x07link\x1b]8;;\x07\u202eevil'), 'redlinkevil');
  assert.equal(sanitize({ value: '\x1b[2Jvalue' }, { redact: false }).value, 'value');
});

test('Markdown escapes attacker-controlled filenames and never embeds arbitrary links', () => {
  const hostile = makeReport('doctor', environment, [{ ...finding, title: '<script>bad</script>', evidence: ['[click](https://evil.example)', 'line\n# heading'], docs: 'javascript:alert(1)' }]);
  const text = renderReport(hostile, 'markdown');
  assert.ok(!text.includes('<script>'));
  assert.ok(!text.includes('[click](https://evil.example)'));
  assert.ok(!text.includes('javascript:'));
  assert.ok(!text.includes('\n# heading'));
});

test('related PowerShell scripts are not mislabeled as unable to execute', () => {
  const lookup = makeReport('which', { ...environment, platform: 'win32', isWSL: false }, [], {
    commands: [{ name: 'npm', selected: 'C:\\Tools\\npm.cmd', candidates: [
      { path: 'C:\\Tools\\npm.cmd', matchesName: true, executable: true },
      { path: 'C:\\Tools\\npm.ps1', matchesName: false, executable: false, shellDependent: true },
    ] }],
  });
  for (const format of ['text', 'markdown']) {
    const text = renderReport(lookup, format);
    assert.ok(text.includes('(PowerShell script; outside PATHEXT selection)'));
    assert.ok(!text.includes('(not executable)'));
  }
});

test('exit policy distinguishes advisory warnings and failures', () => {
  assert.equal(reportExitCode(report()), 0);
  assert.equal(reportExitCode(report(), true), 1);
  assert.equal(reportExitCode(makeReport('doctor', environment, [{ ...finding, status: 'fail' }])), 1);
  assert.throws(() => makeReport('doctor', environment, [finding, finding]), /duplicate/u);
  assert.throws(() => makeReport('doctor', environment, [{ ...finding, status: 'healthy' }]), /Invalid/u);
});

test('snapshot comparisons ignore timestamps but compare evidence and statuses', () => {
  const before = report(), after = report();
  after.generatedAt = 'later';
  after.tool.version = '0.1.1';
  assert.equal(compareSnapshots(before, after).unchanged, 1);
  after.checks = [{ ...finding, status: 'pass', evidence: [] }, { id: 'new', status: 'info', title: 'New' }];
  const changed = compareSnapshots(before, after);
  assert.equal(changed.changed.length, 1);
  assert.equal(changed.added.length, 1);
  assert.ok(renderDiff(changed, 'text').includes('warn -> pass'));
  assert.ok(renderDiff(changed, 'text').includes('Before evidence:'));
  assert.equal(compareSnapshots(after, before).removed.length, 1);
  assert.throws(() => compareSnapshots(before, { ...after, command: 'ports' }), /same command/u);
});

test('text and Markdown diffs expose title-only and remedy-only changes', () => {
  const before = report(), after = report();
  after.checks = [{ ...finding, title: 'Updated title', remedy: 'Updated remedy' }];
  const diff = compareSnapshots(before, after);
  for (const format of ['text', 'markdown']) {
    const text = renderDiff(diff, format);
    assert.ok(text.includes('After title: Updated title'));
    assert.ok(text.includes('After remedy: Updated remedy'));
  }
});

test('snapshot input rejects malformed, oversized, duplicate, and non-regular data', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'wslens-report-'));
  try {
    const file = path.join(dir, 'report.json');
    await writeFile(file, '\uFEFF' + JSON.stringify(report()));
    assert.equal((await readSnapshot(file)).schemaVersion, 1);
    await writeFile(file, '{bad');
    await assert.rejects(readSnapshot(file), /valid JSON/u);
    await writeFile(file, JSON.stringify({ ...report(), schemaVersion: 2 }));
    await assert.rejects(readSnapshot(file), /schemaVersion 1/u);
    await writeFile(file, JSON.stringify({ ...report(), checks: [finding, finding] }));
    await assert.rejects(readSnapshot(file), /duplicate/u);
    await writeFile(file, Buffer.alloc(4 * 1024 * 1024 + 1));
    await assert.rejects(readSnapshot(file), /4 MiB/u);
    await assert.rejects(readSnapshot(dir), /regular file/u);
    if (process.platform !== 'win32') {
      const link = path.join(dir, 'link');
      await symlink(file, link);
      await assert.rejects(readSnapshot(link), /regular file/u);
    }
  } finally { await rm(dir, { recursive: true, force: true }); }
});
