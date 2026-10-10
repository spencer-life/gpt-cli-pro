import test from 'node:test';
import assert from 'node:assert/strict';
import { convertPath, quotePath } from '../src/paths.mjs';
import { runSystem } from '../src/process.mjs';

test('drive paths convert in both directions without dropping spaces or Unicode', () => {
  assert.equal(convertPath('C:\\Users\\Ada\\My app\\résumé.txt'), '/mnt/c/Users/Ada/My app/résumé.txt');
  assert.equal(convertPath('/mnt/d/work/a b', { to: 'windows' }), 'D:\\work\\a b');
  assert.equal(convertPath('D:\\'), '/mnt/d');
  assert.equal(convertPath('/mnt/c'), 'C:\\');
});

test('custom mount roots and root automount preserve drive boundary', () => {
  assert.equal(convertPath('C:\\work', { mountRoot: '/windows/' }), '/windows/c/work');
  assert.equal(convertPath('/windows/c/work', { mountRoot: '/windows' }), 'C:\\work');
  assert.equal(convertPath('C:\\work', { mountRoot: '/' }), '/c/work');
  assert.equal(convertPath('/c/work', { mountRoot: '/' }), 'C:\\work');
  assert.throws(() => convertPath('/mnt/cache/project'), /--distro/u);
});

test('Linux native and WSL UNC paths require explicit distribution context', () => {
  assert.equal(convertPath('/home/ada/work', { distro: 'Ubuntu-24.04' }), '\\\\wsl.localhost\\Ubuntu-24.04\\home\\ada\\work');
  assert.equal(convertPath('\\\\wsl$\\Ubuntu\\home\\ada'), '/home/ada');
  assert.equal(convertPath('\\\\wsl.localhost\\Ubuntu'), '/');
  assert.throws(() => convertPath('\\\\wsl$\\Ubuntu\\home', { distro: 'Debian' }), /differs/u);
  assert.throws(() => convertPath('/home/ada'), /--distro/u);
});

test('ambiguous paths and unsafe names are rejected, not guessed', () => {
  for (const input of ['C:work', '\\\\server\\share\\x', '\\\\?\\C:\\x', '.', '~', 'a\nb', 'C:\\x\u009b2J', 'C:\\x\u202eevil']) {
    assert.throws(() => convertPath(input));
  }
  for (const input of ['/mnt/c/work/file:stream', '/mnt/c/CON.txt', '/mnt/c/COM¹', '/mnt/c/name.']) {
    assert.throws(() => convertPath(input), /cannot be represented/u);
  }
  assert.throws(() => convertPath('C:\\a', { mountRoot: 'relative' }));
  assert.throws(() => convertPath('/home/ada', { distro: '..' }));
  assert.throws(() => convertPath('/home/ada', { to: 'mac' }));
});

test('lexical normalization resolves traversal before selecting a drive', () => {
  assert.equal(convertPath('/mnt/c/a/../b'), 'C:\\b');
  assert.equal(convertPath('C:\\a\\..\\b'), '/mnt/c/b');
  assert.throws(() => convertPath('/mnt/c/../../home/ada'), /--distro/u);
});

test('shell quoting preserves quotes and never evaluates metacharacters', () => {
  assert.equal(quotePath("a'b $x `z`", 'powershell'), "'a''b $x `z`'");
  assert.equal(quotePath("a'b $(whoami)", 'bash'), "'a'\\''b $(whoami)'");
  assert.throws(() => quotePath('a', 'cmd'));
  for (const quote of ['‘', '’', '‚', '‛']) assert.equal(quotePath(`Ada${quote}s app`, 'powershell'), `'Ada${quote}${quote}s app'`);
});

test('native Windows PowerShell evaluates quoted paths as one exact literal', { skip: process.platform !== 'win32' }, async () => {
  for (const value of ["C:\\Ada's app\\$folder", 'C:\\Ada’s app', 'C:\\a’ ; Write-Output INJECTED ; ‘b', 'C:\\x‚‛y']) {
    const script = '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false); [Console]::Write(' + quotePath(value, 'powershell') + ')';
    const result = await runSystem('powershell', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs: 10000 });
    assert.equal(result.ok, true, result.error ?? result.stderr);
    assert.equal(result.stdout, value);
  }
});
