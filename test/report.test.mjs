import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseMountInfo } from '../src/environment.mjs';
import { MAX_SNAPSHOT_BYTES, cleanText, redactText, sanitize, makeReport, renderReport, reportExitCode, readSnapshot, sanitizeSnapshot, compareSnapshots, renderDiff } from '../src/report.mjs';

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

const mountedEnvironment = {
  ...environment, mountInfoStatus: 'ok', mountInfoTruncated: false,
  mounts: parseMountInfo([
    '28 1 8:1 / / rw - ext4 /dev/sdc rw',
    '29 28 0:57 / /mnt/c rw - 9p C:\\134 rw,aname=drvfs;path=C:\\134',
    '30 28 0:58 / /drives/Shared rw - drvfs D:\\134 rw',
    '31 29 8:2 / /mnt/c/native rw - ext4 /dev/sdd rw',
    '32 28 0:59 / /mnt/share rw - 9p linux-share rw,trans=virtio',
  ].join('\n')),
};

test('reports mask casing aliases of project and home roots on confirmed Windows mounts', () => {
  for (const mount of ['/mnt/c', '/drives/Shared']) {
    const project = `${mount}/Work/ConfidentialClient`, home = `${mount}/Profiles/Ada`;
    const projectAlias = `${mount}/work/CONFIDENTIALCLIENT`, homeAlias = `${mount}/profiles/ADA`;
    const evidence = [`${projectAlias}/bin/node`, `${homeAlias}/bin/tool`];
    const diagnostic = makeReport('doctor', mountedEnvironment, [{ ...finding, evidence }], {
      pathEntries: [{ value: `${projectAlias}/bin` }],
      commands: [{ name: 'node', selected: evidence[0], candidates: [{ path: evidence[0], realPath: `${project}/bin/node` }] }],
    }, { root: project });
    const options = { home, project, environment: mountedEnvironment };
    for (const format of ['text', 'json', 'markdown']) {
      const output = renderReport(diagnostic, format, options);
      assert.ok(!output.toLowerCase().includes(project.toLowerCase()), `${format} must mask the project alias`);
      assert.ok(!output.toLowerCase().includes(home.toLowerCase()), `${format} must mask the home alias`);
      assert.ok(output.includes(format === 'markdown' ? '\\<PROJECT\\>/bin/node' : '<PROJECT>/bin/node'));
      assert.ok(output.includes(format === 'markdown' ? '\\<HOME\\>/bin/tool' : '<HOME>/bin/tool'));
    }
    const safe = JSON.parse(renderReport(diagnostic, 'json', options));
    assert.equal(safe.project.root, '<PROJECT>');
    assert.equal(safe.data.commands[0].candidates[0].realPath, '<PROJECT>/bin/node');
    assert.equal(safe.data.pathEntries[0].value, '<PROJECT>/bin');
    assert.equal(safe.privacy.projectRootCaseInsensitive, true);
    assert.equal(Object.hasOwn(safe.environment, 'mounts'), false);
    const raw = JSON.parse(renderReport(diagnostic, 'json', { ...options, redact: false }));
    assert.deepEqual(raw.checks[0].evidence, evidence);
    assert.equal(raw.privacy.projectRootCaseInsensitive, true, 'Raw snapshots retain the masking policy for a later diff');
  }
});

test('mount-aware masking preserves Linux case distinctions and project component boundaries', () => {
  const project = '/mnt/c/Work/Private', sibling = '/mnt/c/work/PRIVATE-other/bin';
  const options = { project, environment: mountedEnvironment };
  const diagnostic = makeReport('doctor', mountedEnvironment, [{ ...finding, evidence: [sibling, `${project}/bin`] }], {}, { root: project });
  assert.deepEqual(JSON.parse(renderReport(diagnostic, 'json', options)).checks[0].evidence, [sibling, '<PROJECT>/bin']);
  for (const [root, source] of [
    ['/work/Private', mountedEnvironment],
    ['/mnt/c/native/Private', mountedEnvironment],
    ['/mnt/share/Private', mountedEnvironment],
    ['/mnt/c/Work/Private', { ...mountedEnvironment, mounts: [], mountInfoStatus: 'unavailable' }],
    ['/mnt/c/Work/Private', { ...mountedEnvironment, mountInfoTruncated: true }],
  ]) {
    const alias = `${root.toLowerCase()}/bin`;
    const snapshot = makeReport('doctor', source, [{ ...finding, evidence: [alias, `${root}/bin`] }], {}, { root });
    const safe = JSON.parse(renderReport(snapshot, 'json', { project: root, environment: source }));
    assert.deepEqual(safe.checks[0].evidence, [alias, '<PROJECT>/bin']);
    assert.equal(safe.privacy.projectRootCaseInsensitive, false);
  }
});

test('project and home roots use their own filesystem evidence for masking', () => {
  for (const [project, home, expected] of [
    ['/mnt/c/Work/Private', '/mnt/c/native/Profile/Ada', ['<PROJECT>/bin', '/mnt/c/native/profile/ada/bin']],
    ['/mnt/c/native/Work/Private', '/mnt/c/Profile/Ada', ['/mnt/c/native/work/private/bin', '<HOME>/bin']],
  ]) {
    const diagnostic = makeReport('doctor', mountedEnvironment, [{ ...finding, evidence: [`${project.toLowerCase()}/bin`, `${home.toLowerCase()}/bin`] }], {}, { root: project });
    const safe = JSON.parse(renderReport(diagnostic, 'json', { project, home, environment: mountedEnvironment }));
    assert.deepEqual(safe.checks[0].evidence, expected);
  }
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

test('redaction cleans project and home roots before matching sanitized values', () => {
  const project = '/private/Se\x1b[31mcret';
  const home = '/accounts/A\x07da';
  const cleanProject = cleanText(project);
  const cleanHome = cleanText(home);
  assert.equal(cleanProject, '/private/Secret');
  assert.equal(cleanHome, '/accounts/Ada');
  const message = 'Project ' + project + '/src/main.mjs and home ' + home + '/bin; sibling ' + cleanProject + '-backup/run';
  assert.equal(redactText(message, { project, home }),
    'Project <PROJECT>/src/main.mjs and home <HOME>/bin; sibling ' + cleanProject + '-backup/run');
  assert.equal(redactText('/private/secret/bin', { project }), '/private/secret/bin',
    'Ordinary POSIX roots must remain case-sensitive.');
  assert.equal(redactText(cleanProject + 'Extra/bin', { project }), cleanProject + 'Extra/bin',
    'The cleaned prefix must still require a path-component boundary.');
  assert.equal(redactText('visible', { project: '\x1b[31m', home: '\x00' }), 'visible',
    'A root cleaned to the empty string must not be used as a matcher.');
});

test('cleaned roots are masked throughout text, JSON, Markdown, and imported snapshots', () => {
  const project = '/private/Se\x1b[31mcret';
  const home = '/accounts/A\x01da';
  const diagnostic = makeReport('doctor', environment, [{
    id: 'root-control-characters', status: 'warn', title: 'Inspect paths',
    detail: project + '/script.sh', evidence: [cleanText(project) + '/node', home + '/tool'],
    remedy: 'Check ' + cleanText(home) + '/settings',
  }], { pathEntries: [{ value: project + '/bin' }] }, { root: project });
  for (const format of ['text', 'json', 'markdown']) {
    const text = renderReport(diagnostic, format, { project, home });
    assert.equal(text.includes(cleanText(project) + '/'), false, format + ' exposed the project path');
    assert.equal(text.includes(cleanText(home) + '/'), false, format + ' exposed the home path');
    assert.match(text, /PROJECT/u);
    assert.match(text, /HOME/u);
  }
  const raw = JSON.parse(renderReport(diagnostic, 'json', { project, home, redact: false }));
  assert.equal(raw.project.root, cleanText(project));
  const sanitized = sanitizeSnapshot(raw, { home });
  assert.equal(sanitized.project.root, '<PROJECT>');
  assert.equal(sanitized.checks[0].detail, '<PROJECT>/script.sh');
  assert.equal(sanitized.checks[0].evidence[1], '<HOME>/tool');
});

test('cleaned Windows and WSL-mounted roots retain case-insensitive masking and boundaries', () => {
  const windowsProject = 'C:\\Work\\Sec\x1b[32mret';
  assert.equal(redactText('c:\\WORK\\SECRET\\bin', { project: windowsProject }), '<PROJECT>\\bin');
  assert.equal(redactText('c:\\WORK\\SECRET-extra\\bin', { project: windowsProject }),
    'c:\\WORK\\SECRET-extra\\bin');
  const mountedProject = '/mnt/c/Se\x1b[33mcret';
  const diagnostic = makeReport('doctor', mountedEnvironment, [{
    ...finding, detail: '/MNT/C/SECRET/run.sh', evidence: ['/mnt/c/secret-backup/run.sh'],
  }], {}, { root: mountedProject });
  const safe = JSON.parse(renderReport(diagnostic, 'json', { project: mountedProject, environment: mountedEnvironment }));
  assert.equal(safe.project.root, '<PROJECT>');
  assert.equal(safe.checks[0].detail, '<PROJECT>/run.sh');
  assert.equal(safe.checks[0].evidence[0], '/mnt/c/secret-backup/run.sh');
  assert.equal(safe.privacy.projectRootCaseInsensitive, true);
});


function largeCommandReport(status = 'info') {
  const commands = Array.from({ length: 20 }, (_, commandIndex) => ({
    name: 'tool' + commandIndex, selected: '/tools/tool' + commandIndex, observedFirst: '/tools/tool' + commandIndex,
    complete: true, note: 'External PATH inspection completed.',
    candidates: Array.from({ length: 256 }, (_, index) => {
      const filename = '/mnt/c/' + 'long-directory-'.repeat(32) + '/' + index + '/tool' + commandIndex;
      return { path: filename, realPath: filename, executable: true, matchesName: true, kind: 'file', pathIndex: index };
    }),
  }));
  return makeReport('which', { platform: 'linux', arch: 'x64', release: 'fixture', isWSL: false }, [
    { id: 'which.fixture', status, title: 'Synthetic command inspection', detail: 'The selected lookup was observed.', evidence: [] },
  ], { commands });
}

test('generated JSON fits the same 4 MiB limit as snapshot imports without hiding omissions', () => {
  const original = largeCommandReport();
  assert.ok(Buffer.byteLength(JSON.stringify(original, null, 2) + '\n') > MAX_SNAPSHOT_BYTES,
    'Fixture must reproduce a diagnostic larger than the input limit.');
  for (const redact of [true, false]) {
    const json = renderReport(original, 'json', { redact });
    assert.ok(Buffer.byteLength(json, 'utf8') <= MAX_SNAPSHOT_BYTES, 'Generated snapshot exceeded the read limit.');
    const saved = JSON.parse(json);
    assert.equal(saved.data.commands.length, 20);
    assert.equal(saved.data.commands[0].selected, '/tools/tool0');
    assert.deepEqual(saved.checks.map(check => check.id), ['which.fixture', 'report.snapshot-limited']);
    assert.equal(saved.summary.warn, 1);
    assert.equal(saved.data.inventoryLimit.maxBytes, MAX_SNAPSHOT_BYTES);
    assert.ok(saved.data.inventoryLimit.omittedCandidates > 0);
    const retained = saved.data.commands.reduce((count, command) => count + command.candidates.length, 0);
    assert.equal(retained + saved.data.inventoryLimit.omittedCandidates, 5120);
    assert.ok(saved.data.commands[0].candidates.length > 0, 'Useful candidate evidence should remain.');
    assert.equal(saved.data.commands[0].candidates[0].path, original.data.commands[0].candidates[0].path);
    assert.ok(saved.data.commands.every(command => command.candidatesTotal === 256));
    assert.ok(saved.data.commands.some(command => command.candidatesTruncated));
    assert.equal(reportExitCode(saved), 0, 'An inventory warning does not fail a normal command.');
    assert.equal(reportExitCode(saved, true), 1, 'Strict mode must include the new warning.');
  }
  assert.equal(original.data.commands[0].candidates.length, 256, 'Rendering must not mutate the inspection data.');
  assert.equal(original.checks.length, 1, 'Rendering must not mutate finding counts.');
});

test('oversized listener inventories are bounded instead of becoming invalid snapshots', () => {
  const listeners = Array.from({ length: 4096 }, (_, index) => ({
    address: '127.0.0.1', port: 3000, pid: index, process: 'long-process-'.repeat(85),
  }));
  const original = makeReport('ports', environment, [], { listeners });
  assert.ok(Buffer.byteLength(JSON.stringify(original, null, 2) + '\n') > MAX_SNAPSHOT_BYTES);
  const savedJson = renderReport(original, 'json');
  const saved = JSON.parse(savedJson);
  assert.ok(Buffer.byteLength(savedJson) <= MAX_SNAPSHOT_BYTES);
  assert.equal(saved.data.listeners.length + saved.data.inventoryLimit.omittedListeners, listeners.length);
  assert.ok(saved.data.inventoryLimit.omittedListeners > 0);
  assert.equal(saved.checks.at(-1).id, 'report.snapshot-limited');
});

test('oversized findings fail clearly rather than emit unreadable snapshot JSON', () => {
  const huge = makeReport('which', environment, [{
    id: 'fixture.too-large', status: 'warn', title: 'Oversized evidence', evidence: ['e'.repeat(MAX_SNAPSHOT_BYTES)],
  }], {});
  assert.throws(() => renderReport(huge, 'json'), /Diagnostic JSON exceeds the 4 MiB snapshot limit/u);
});


test('finding identifiers must be stable under sanitization on creation and import', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wslens-snapshot-ids-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'snapshot.json');
  const good = { schemaVersion: 1, tool: { name: 'wslens' }, command: 'which',
    checks: [{ id: 'same', title: 'Healthy', status: 'pass' }] };
  const variants = ['sa\x1b[31mme', 'sa\x01me', 'sa\u202eme', 'sa\x7fme'];
  for (const id of variants) {
    assert.equal(cleanText(id), 'same', 'The fixture must collide under report cleaning.');
    assert.throws(() => makeReport('which', environment, [
      { id, status: 'fail', title: 'Hidden failure' }, { id: 'same', status: 'pass', title: 'Healthy' },
    ]), /Invalid or duplicate finding identifier/u);
    await writeFile(file, JSON.stringify({ ...good,
      checks: [{ id, status: 'fail', title: 'Hidden failure' }, good.checks[0]] }));
    await assert.rejects(readSnapshot(file), /invalid or duplicate finding/u);
  }
  await writeFile(file, JSON.stringify(good));
  const parsed = await readSnapshot(file);
  assert.deepEqual(parsed.checks.map(check => check.id), ['same']);
  assert.equal(parsed.checks[0].status, 'pass');
});

test('untrusted snapshot field-name aliases cannot shadow schema fields', async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), 'wslens-snapshot-shadow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = path.join(root, 'snapshot.json');
  const original = { schemaVersion: 1, tool: { name: 'wslens' }, command: 'which',
    checks: [{ id: 'same', title: 'Real finding', status: 'fail' }] };
  await writeFile(file, JSON.stringify({ ...original, ['che\x1b[31mcks']: [
    { id: 'same', title: 'Shadowing pass', status: 'pass' },
  ] }));
  await assert.rejects(readSnapshot(file), /field name modified by sanitization/u);
  await writeFile(file, JSON.stringify({ ...original, checks: [
    { id: 'same', title: 'Real finding', status: 'fail', ['ti\x1b[31mtle']: 'Forged title' },
  ] }));
  await assert.rejects(readSnapshot(file), /field name modified by sanitization/u);
});


test('snapshot IDs remain stable through the full project/home redaction policy', () => {
  const root = '/private/secret-project';
  const failing = { id: root + '/same', title: 'Failure that would disappear', status: 'fail' };
  const healthy = { id: '<PROJECT>/same', title: 'Healthy finding', status: 'pass' };
  const sample = makeReport('doctor', environment, [failing, healthy], {}, { root });

  // Neither ID is changed by cleanText, but project substitution would cause
  // both keys to be the identical literal "<PROJECT>/same".
  assert.equal(cleanText(failing.id), failing.id);
  assert.throws(() => sanitizeSnapshot(sample), /finding identifier modified by sanitization or redaction/u);
  assert.deepEqual(sanitizeSnapshot(sample, { redact: false }).checks.map(check => check.id),
    [failing.id, healthy.id]);

  const privateHome = '/people/Ada Private';
  const homeReport = makeReport('which', environment, [
    { id: privateHome + '/status', title: 'Private home finding', status: 'warn' },
  ]);
  assert.throws(() => sanitizeSnapshot(homeReport, { home: privateHome }), /finding identifier modified by sanitization or redaction/u);

  const windows = makeReport('doctor', environment, [
    { id: 'c:\\work\\PROJECT\\status', title: 'Windows alias finding', status: 'warn' },
  ], {}, { root: 'C:\\Work\\Project' });
  windows.privacy = { projectRootCaseInsensitive: true };
  assert.throws(() => sanitizeSnapshot(windows), /finding identifier modified by sanitization or redaction/u);

  const sibling = makeReport('doctor', environment, [
    { id: root + '-backup/status', title: 'Different directory', status: 'info' },
  ], {}, { root });
  assert.equal(sanitizeSnapshot(sibling).checks[0].id, root + '-backup/status',
    'Component boundaries still distinguish sibling paths.');
});
