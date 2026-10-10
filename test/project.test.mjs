import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { inspectProject } from '../src/project.mjs';
import { runSystem } from '../src/process.mjs';

const HASH = 'a'.repeat(40);
const environment = { platform: process.platform };
const noGit = async () => ({ ok: false, stdout: '', stderr: '', code: null, unavailable: true });

async function fixture(t) {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), 'wslens-project-'));
  const root = path.join(base, 'project');
  await fs.mkdir(root);
  t.after(() => fs.rm(base, { recursive: true, force: true }));
  return {
    base, root,
    async write(relative, content) {
      const filename = path.join(root, ...relative.split('/'));
      await fs.mkdir(path.dirname(filename), { recursive: true });
      await fs.writeFile(filename, content);
      return filename;
    },
    async git(...args) {
      const result = await runSystem('git', args, { cwd: root });
      assert.equal(result.ok, true, `git ${args[0]} failed: ${result.error ?? result.stderr}`);
      return result;
    },
  };
}

function indexOutput(entries) {
  return entries.map((entry) => {
    const item = typeof entry === 'string' ? { relative: entry } : entry;
    return `${item.mode ?? '100644'} ${HASH} ${item.stage ?? '0'}\t${item.relative}\0`;
  }).join('');
}

function withIndex(entries) {
  const output = Array.isArray(entries) ? indexOutput(entries) : entries;
  return async (name, args) => {
    assert.equal(name, 'git');
    if (args[0] === 'rev-parse') return { ok: true, stdout: 'true\n', stderr: '', code: 0 };
    assert.deepEqual(args, ['ls-files', '--stage', '-z']);
    return { ok: true, stdout: output, stderr: '', code: 0 };
  };
}

function finding(result, id) {
  return result.checks.find((check) => check.id === id);
}

test('real Git index scopes the scan to tracked files without running project code', async (t) => {
  const f = await fixture(t);
  const available = await runSystem('git', ['--version']);
  if (available.unavailable) return t.skip('trusted system Git unavailable');
  await f.git('init', '--quiet');
  await f.write('scripts/ok.sh', '#!/bin/sh\necho DoNotRunThis\n');
  await f.write('readme.txt', 'Project documentation\n');
  await f.write('.env', '#!/bin/sh\r\nPRIVATE_ENV_CONTENT\r\n');
  await f.write('untracked.sh', '#!/bin/sh\r\necho untracked\r\n');
  await f.git('add', '--', 'scripts/ok.sh', 'readme.txt', '.env');
  await f.git('update-index', '--chmod=+x', '--', 'scripts/ok.sh');
  const result = await inspectProject(f.root, environment);
  assert.equal(result.project.source, 'git');
  assert.equal(result.project.scannedFiles, 3);
  assert.equal(result.project.inspectedHeaders, 1);
  assert.equal(result.project.skippedSensitive, 1);
  assert.equal(result.project.complete, true);
  assert.equal(finding(result, 'project.script-crlf'), undefined);
  assert.equal(finding(result, 'project.script-mode'), undefined);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ENV_CONTENT|DoNotRunThis|untracked\.sh/u);
  assert.equal(new Set(result.checks.map((check) => check.id)).size, result.checks.length);
});

test('an empty real Git index is distinct from a clean untracked directory', async (t) => {
  const f = await fixture(t);
  const available = await runSystem('git', ['--version']);
  if (available.unavailable) return t.skip('trusted system Git unavailable');
  await f.git('init', '--quiet');
  await f.write('untracked.sh', '#!/bin/sh\r\n');
  const result = await inspectProject(f.root, environment);
  assert.equal(result.project.source, 'git');
  assert.equal(result.project.scannedFiles, 0);
  assert.equal(result.project.indexEmpty, true);
  assert.match(finding(result, 'project.scope').detail, /index is empty/u);
  assert.equal(result.checks.some((check) => check.status === 'pass'), false);
});

test('fallback skips generated and sensitive paths while inspecting normal scripts', async (t) => {
  const f = await fixture(t);
  await f.write('scripts/run.sh', '#!/bin/sh\r\necho broken\r\n');
  await f.write('.env.sh', '#!/bin/sh\r\nPRIVATE_ENV\r\n');
  await f.write('id_rsa', '#!/bin/sh\r\nPRIVATE_KEY\r\n');
  await f.write('private.key', '#!/bin/sh\r\nPRIVATE_KEY\r\n');
  for (const directory of ['node_modules', '.git', 'dist', '.venv', '.ssh']) {
    await f.write(`${directory}/hidden.sh`, '#!/bin/sh\r\nSKIP_THIS_CONTENT\r\n');
  }
  const result = await inspectProject(f.root, { platform: 'linux' }, { run: noGit });
  assert.equal(result.project.source, 'filesystem');
  assert.equal(result.project.gitStatus, 'unavailable');
  assert.equal(finding(result, 'project.scope').status, 'skip');
  assert.equal(result.project.inspectedHeaders, 1);
  assert.ok(result.project.skippedSensitive >= 4);
  assert.deepEqual(finding(result, 'project.script-crlf').evidence, ['scripts/run.sh']);
  assert.doesNotMatch(JSON.stringify(result), /PRIVATE_ENV|PRIVATE_KEY|SKIP_THIS_CONTENT|hidden\.sh/u);
});

test('Windows names include device extensions, superscript digits, and directory components', async (t) => {
  const f = await fixture(t);
  const entries = ['AUX.txt', 'folder/COM¹.log', 'folder/lpt².txt', 'space /file.txt', 'dir/dot.', 'a?b.txt', 'good.txt'];
  const result = await inspectProject(f.root, environment, { run: withIndex(entries) });
  const check = finding(result, 'project.windows-names');
  assert.equal(check.status, 'warn');
  assert.equal(check.evidence.length, 6);
  assert.match(check.evidence.join('\n'), /COM¹\.log: Windows device name/u);
  assert.match(check.evidence.join('\n'), /space : trailing space or period/u);
  assert.doesNotMatch(check.evidence.join('\n'), /good\.txt/u);
});

test('case collisions include directory prefixes even when child names differ', async (t) => {
  const f = await fixture(t);
  const result = await inspectProject(f.root, environment, {
    run: withIndex(['Src/a.txt', 'src/b.txt', 'src/File.txt', 'src/file.txt']),
  });
  const check = finding(result, 'project.case-collisions');
  assert.equal(check.status, 'warn');
  assert.deepEqual(check.evidence, ['Src | src', 'src/File.txt | src/file.txt']);
});

test('script checks distinguish Unix headers from Windows files, ordinary CRLF text, and binaries', async (t) => {
  const f = await fixture(t);
  const files = {
    'crlf.sh': '#!/bin/sh\r\necho hello\r\n',
    'body.sh': '#!/bin/sh\necho hello\r\n',
    'cli.py': '#!/usr/bin/env python\r\nprint(1)\r\n',
    'plain.py': '# A normal Python file\r\nprint(1)\r\n',
    'normal.sh': '#!/bin/sh\necho fine\n',
    'windows.cmd': '@echo off\r\n',
    'windows.ps1': '\ufeffWrite-Output hello\r\n',
    'bom.sh': '\ufeff#!/bin/sh\necho fine\n',
    'wide.sh': Buffer.from([0xff, 0xfe, 0x23, 0, 0x21, 0]),
    'binary.sh': Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0, 13, 10]),
  };
  for (const [relative, content] of Object.entries(files)) await f.write(relative, content);
  const result = await inspectProject(f.root, { platform: 'linux' }, {
    run: withIndex(Object.keys(files).map((relative) => ({ relative, mode: '100755' }))),
  });
  assert.equal(finding(result, 'project.script-crlf').status, 'fail');
  assert.deepEqual(finding(result, 'project.script-crlf').evidence, ['body.sh', 'cli.py', 'crlf.sh']);
  assert.deepEqual(finding(result, 'project.script-bom').evidence, ['bom.sh', 'wide.sh']);
  assert.equal(result.project.binaryHeaders, 1);
  assert.doesNotMatch(JSON.stringify(result), /echo hello|print\(1\)|Write-Output/u);
  const windows = await inspectProject(f.root, { platform: 'win32' }, { run: withIndex(['crlf.sh']) });
  assert.equal(finding(windows, 'project.script-crlf').status, 'warn');
});

test('non-executable shebang scripts are advice, including extensionless commands', async (t) => {
  const f = await fixture(t);
  await f.write('bin/tool', '#!/usr/bin/env node\nconsole.log(1);\n');
  await f.write('scripts/explicit.sh', 'echo intended for bash\n');
  const result = await inspectProject(f.root, environment, { run: withIndex(['bin/tool', 'scripts/explicit.sh']) });
  const check = finding(result, 'project.script-mode');
  assert.equal(check.status, 'info');
  assert.deepEqual(check.evidence, ['bin/tool']);
});

test('symlinks and symlinked parents never expose external script headers', async (t) => {
  const f = await fixture(t);
  const outside = path.join(f.base, 'outside');
  await fs.mkdir(outside);
  await fs.writeFile(path.join(outside, 'danger.sh'), '#!/bin/sh\r\nOUTSIDE_PRIVATE_MARKER\r\n');
  try {
    await fs.symlink(path.join(outside, 'danger.sh'), path.join(f.root, 'link.sh'), 'file');
    await fs.symlink(outside, path.join(f.root, 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlink creation unavailable');
    throw error;
  }
  const result = await inspectProject(f.root, environment, {
    run: withIndex(['link.sh', 'linked/danger.sh', { relative: 'index-link', mode: '120000' }]),
  });
  assert.equal(result.project.bytesRead, 0);
  assert.equal(result.project.inspectedHeaders, 0);
  assert.equal(finding(result, 'project.script-crlf'), undefined);
  assert.deepEqual(finding(result, 'project.symlinks').evidence, ['index-link', 'link.sh', 'linked']);
  assert.doesNotMatch(JSON.stringify(result), /OUTSIDE_PRIVATE_MARKER/u);
  const fallback = await inspectProject(f.root, environment, { run: noGit });
  assert.equal(fallback.project.bytesRead, 0);
  assert.equal(finding(fallback, 'project.script-crlf'), undefined);
});

test('a symlink project root is rejected without inspecting its target', async (t) => {
  const f = await fixture(t);
  const link = path.join(f.base, 'alias');
  try {
    await fs.symlink(f.root, link, process.platform === 'win32' ? 'junction' : 'dir');
  } catch (error) {
    if (['EPERM', 'EACCES', 'ENOTSUP'].includes(error.code)) return t.skip('symlink creation unavailable');
    throw error;
  }
  let gitCalled = false;
  const result = await inspectProject(link, environment, { run: async () => { gitCalled = true; return noGit(); } });
  assert.equal(finding(result, 'project.root').status, 'fail');
  assert.equal(gitCalled, false);
});

test('malformed and traversal metadata cannot read outside the root or cause a false pass', async (t) => {
  const f = await fixture(t);
  await f.write('scripts/good.sh', '#!/bin/sh\n');
  await fs.writeFile(path.join(f.base, 'outside.sh'), '#!/bin/sh\r\nESCAPE_MARKER\r\n');
  const malformed = indexOutput([
    'scripts/good.sh', '../outside.sh', 'a/../../outside.sh', '/tmp/outside.sh',
    'C:/outside.sh', 'a\\..\\outside.sh', '.git/hooks/hook.sh',
  ]) + 'not a Git record\0' + `100644 ${HASH} 0\tunterminated.sh`;
  const result = await inspectProject(f.root, environment, { run: withIndex(malformed) });
  assert.equal(result.project.scannedFiles, 1);
  assert.equal(result.project.invalidMetadata, 8);
  assert.equal(result.project.complete, false);
  assert.equal(result.checks.some((check) => check.status === 'pass'), false);
  assert.equal(finding(result, 'project.script-crlf'), undefined);
  assert.doesNotMatch(JSON.stringify(result), /ESCAPE_MARKER/u);
});

test('NUL records preserve tab and newline filenames and deduplicate merge stages', async (t) => {
  const f = await fixture(t);
  const result = await inspectProject(f.root, environment, {
    run: withIndex([
      { relative: 'odd\tname.txt', stage: '1' }, { relative: 'odd\tname.txt', stage: '2' },
      'new\nline.txt', 'okay.txt',
    ]),
  });
  assert.equal(result.project.scannedFiles, 3);
  assert.equal(result.project.invalidMetadata, 0);
  assert.equal(finding(result, 'project.windows-names').evidence.length, 2);
});

test('file and byte budgets explicitly mark incomplete inspection', async (t) => {
  const f = await fixture(t);
  for (let i = 0; i < 5; i++) await f.write(`file${i}.txt`, 'text');
  const count = await inspectProject(f.root, environment, { run: noGit, maxFiles: 2 });
  assert.equal(count.project.scannedFiles, 2);
  assert.equal(count.project.truncated, true);
  assert.equal(count.checks.some((check) => check.status === 'pass'), false);
  assert.match(finding(count, 'project.incomplete').detail, /file count/u);
  await f.write('large.sh', '#!/bin/sh\n' + '#'.repeat(200));
  const bytes = await inspectProject(f.root, environment, {
    run: withIndex(['large.sh']), maxBytes: 16, headerBytes: 64,
  });
  assert.equal(bytes.project.bytesRead, 16);
  assert.equal(bytes.project.truncated, true);
  assert.match(finding(bytes, 'project.incomplete').detail, /header byte count/u);
});

test('a huge script is sampled without loading its body', async (t) => {
  const f = await fixture(t);
  const filename = await f.write('huge.sh', '#!/bin/sh\n' + '#'.repeat(100));
  await fs.truncate(filename, 64 * 1024 * 1024);
  const result = await inspectProject(f.root, environment, { run: withIndex(['huge.sh']), headerBytes: 64 });
  assert.equal(result.project.bytesRead, 64);
  assert.equal(result.project.inspectedHeaders, 1);
  assert.equal(result.project.unixHeaders, 1);
  assert.equal(result.project.truncated, false);
  assert.match(finding(result, 'project.script-headers').detail, /up to 64 bytes/u);
});

test('oversized Git output, missing tracked scripts, and submodules are explicit', async (t) => {
  const f = await fixture(t);
  const large = await inspectProject(f.root, environment, {
    run: withIndex(['first.txt', 'second.txt', 'third.txt']), maxGitBytes: 100,
  });
  assert.equal(large.project.truncated, true);
  assert.match(finding(large, 'project.incomplete').detail, /Git output/u);
  const missing = await inspectProject(f.root, environment, {
    run: withIndex(['missing.sh', { relative: 'dependency', mode: '160000' }]),
  });
  assert.equal(missing.project.inaccessible, 1);
  assert.equal(missing.project.complete, false);
  assert.deepEqual(finding(missing, 'project.incomplete').evidence, ['missing.sh']);
  assert.equal(finding(missing, 'project.submodules').status, 'info');
});

test('implicit directory components and excessive Git nesting respect scan limits', async (t) => {
  const f = await fixture(t);
  const components = await inspectProject(f.root, environment, {
    run: withIndex(['a/b/c/d/file.txt']), maxEntries: 3,
  });
  assert.equal(components.project.truncated, true);
  assert.match(finding(components, 'project.incomplete').detail, /path component count/u);
  assert.equal(components.checks.some((check) => check.status === 'pass'), false);
  const depth = await inspectProject(f.root, environment, {
    run: withIndex(['a/b/c/d/file.txt']), maxDepth: 2,
  });
  assert.equal(depth.project.scannedFiles, 0);
  assert.equal(depth.project.indexEmpty, false);
  assert.doesNotMatch(finding(depth, 'project.scope').detail, /index is empty/u);
  assert.equal(depth.project.truncated, true);
  assert.match(finding(depth, 'project.incomplete').detail, /Git path depth/u);
});

test('Git errors and non-repositories are different fallback states', async (t) => {
  const f = await fixture(t);
  await f.write('script.sh', '#!/bin/sh\n');
  const notRepo = await inspectProject(f.root, environment, {
    run: async () => ({ ok: false, stdout: '', stderr: 'fatal: not a git repository', code: 128 }),
  });
  assert.equal(notRepo.project.gitStatus, 'not-repository');
  assert.equal(notRepo.project.complete, true);
  const failed = await inspectProject(f.root, environment, {
    run: async () => ({ ok: false, stdout: '', stderr: 'unexpected failure with secret output', code: 128 }),
  });
  assert.equal(failed.project.gitStatus, 'error');
  assert.equal(failed.project.complete, false);
  assert.doesNotMatch(JSON.stringify(failed), /secret output/u);
});

test('time budget bounds an unresponsive Git adapter', async (t) => {
  const f = await fixture(t);
  const started = performance.now();
  const result = await inspectProject(f.root, environment, {
    run: () => new Promise(() => {}), maxDurationMs: 40,
  });
  assert.equal(result.project.truncated, true);
  assert.equal(result.project.complete, false);
  assert.ok(performance.now() - started < 1000);
});
