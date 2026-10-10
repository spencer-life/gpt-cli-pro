import { open, lstat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { stripVTControlCharacters } from 'node:util';

export const VERSION = '0.1.0';
export const STATUSES = ['fail', 'warn', 'info', 'pass', 'skip'];
const MAX_REPORT_BYTES = 4 * 1024 * 1024;

export function cleanText(value) {
  return stripVTControlCharacters(String(value)).replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/gu, '').replaceAll('\r', '');
}

function inline(value) { return cleanText(value).replaceAll('\n', '\\n').replaceAll('\t', '\\t'); }
function markdown(value) { return inline(value).replace(/[\\`*_{}[\]()#+.!|<>~-]/gu, '\\$&'); }
function escapeRegExp(value) { return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'); }
function candidateQualifier(candidate) {
  if (candidate.matchesName === false) return candidate.shellDependent
    ? ' (PowerShell script; outside PATHEXT selection)'
    : ' (related name; not selected)';
  return candidate.executable === false ? ' (not executable)' : '';
}

export function redactText(value, { home, project } = {}) {
  let text = cleanText(value);
  // Replace specific roots first, preserving where within the project a finding occurred.
  for (const [root, replacement] of [[project, '<PROJECT>'], [home, '<HOME>']]) {
    if (!root || root === '/' || /^[a-z]:[\\/]?$/iu.test(root)) continue;
    const variants = [...new Set([root.replace(/[\\/]$/u, ''), root.replaceAll('\\', '/').replace(/\/$/u, ''),
      ...(/^[a-z]:|^[\\/]{2}/iu.test(root) ? [root.replaceAll('/', '\\').replace(/\\$/u, '')] : [])])];
    for (const variant of variants) {
      if (!variant) continue;
      const flags = /^[a-z]:|^\\\\/iu.test(variant) ? 'giu' : 'gu';
      text = text.replace(new RegExp(escapeRegExp(variant) + '(?=$|[\\\\/\\s"\'`,;:)}\\]])', flags), replacement);
    }
  }
  // Cover the other OS's home and other users shown by PATH entries too.
  text = text.replace(/((?:[a-z]:)?[\\/]Users[\\/])[^\\/\n\r\t]+/giu, '$1<USER>');
  text = text.replace(/(\/home\/)[^/\n\r\t]+/gu, '$1<USER>');
  text = text.replace(/(\/mnt\/[a-z]\/Users\/)[^/\n\r\t]+/giu, '$1<USER>');
  text = text.replace(/\b(https?:\/\/)[^\s/@]+:[^\s/@]+@/giu, '$1<REDACTED>@');
  return text;
}

export function sanitize(value, options = {}, depth = 0) {
  if (depth > 30) return '[nested data omitted]';
  if (typeof value === 'string') return options.redact === false ? cleanText(value) : redactText(value, options);
  if (Array.isArray(value)) return value.map(item => sanitize(item, options, depth + 1));
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [cleanText(key), sanitize(item, options, depth + 1)]));
  }
  return value;
}

export function makeReport(command, environment, checks, data = {}, project) {
  const seen = new Set();
  for (const check of checks) {
    if (!check.id || seen.has(check.id) || !STATUSES.includes(check.status)) throw new Error('Invalid or duplicate finding identifier.');
    seen.add(check.id);
  }
  const summary = Object.fromEntries(STATUSES.map(status => [status, checks.filter(check => check.status === status).length]));
  return {
    schemaVersion: 1,
    tool: { name: 'wslens', version: VERSION },
    command,
    generatedAt: new Date().toISOString(),
    environment: {
      platform: environment.platform,
      arch: environment.arch,
      release: environment.release,
      isWSL: Boolean(environment.isWSL),
      wslVersion: environment.wslVersion ?? null,
      distro: environment.distro ?? null,
      nodeVersion: process.version,
    },
    ...(project ? { project } : {}),
    checks,
    summary,
    data,
  };
}

export function reportExitCode(report, strict = false) {
  return report.checks.some(check => check.status === 'fail' || (strict && check.status === 'warn')) ? 1 : 0;
}

export function renderReport(report, format = 'text', options = {}) {
  const safe = sanitize(report, options);
  safe.privacy = { redacted: options.redact !== false, scope: 'Home/project paths masked; review remaining filenames and process names before sharing.' };
  if (format === 'json') return JSON.stringify(safe, null, 2) + '\n';
  const checks = [...safe.checks].sort((a, b) => STATUSES.indexOf(a.status) - STATUSES.indexOf(b.status));
  const summary = STATUSES.map(status => `${safe.summary[status] ?? 0} ${status}`).join(' | ');
  if (format === 'markdown') {
    const lines = [`# WSLens ${markdown(safe.tool.version)} — ${markdown(safe.command)}`, '',
      `${markdown(safe.environment.platform)} ${markdown(safe.environment.arch)}${safe.environment.isWSL ? ' · WSL ' + markdown(safe.environment.wslVersion ?? '?') : ''}`, '',
      `**${markdown(summary)}**`, ''];
    if (safe.project?.root) lines.push(`Project: ${markdown(safe.project.root)}`, '');
    if (safe.command === 'which' && safe.data.commands?.length) {
      lines.push('## Command candidates', '', 'External PATH lookup only; runtimes are never executed.', '');
      for (const command of safe.data.commands) {
        lines.push(`### ${markdown(command.name)}`, '', `${safe.environment.platform === 'win32' ? 'PATHEXT selection' : 'PATH selection'}: ${markdown(command.selected ?? '(unresolved)')}`, '');
        for (const candidate of command.candidates ?? []) {
          lines.push(`- ${markdown(candidate.path)}${candidate.realPath && candidate.realPath !== candidate.path ? ' → ' + markdown(candidate.realPath) : ''}${candidateQualifier(candidate)}`);
        }
        if (command.note) lines.push('', markdown(command.note));
        lines.push('');
      }
    }
    for (const check of checks) {
      lines.push(`## ${check.status.toUpperCase()} · ${markdown(check.title)}`, '', `ID: ${markdown(check.id)}`, '', markdown(check.detail ?? ''), '');
      if (check.evidence?.length) lines.push(...check.evidence.map(item => '- ' + markdown(item)), '');
      if (check.remedy) lines.push(`**Next step:** ${markdown(check.remedy)}`, '');
      if (check.docs && /^https:\/\/[a-z0-9.-]+\/[a-z0-9_./?#=&%:-]*$/iu.test(check.docs)) lines.push(`[Reference](${check.docs})`, '');
    }
    lines.push(options.redact === false ? '*Path redaction is disabled.*' : '*Home and project roots are masked. Review filenames and process names before sharing.*', '');
    return lines.join('\n');
  }
  if (format !== 'text') throw new Error('Unknown output format.');
  const colors = { fail: 31, warn: 33, info: 36, pass: 32, skip: 90 };
  const color = (text, code) => options.color ? `\x1b[${code}m${text}\x1b[0m` : text;
  const lines = [color(`WSLens ${safe.tool.version}  ${inline(safe.command)}`, 1),
    `${inline(safe.environment.platform)} ${inline(safe.environment.arch)}${safe.environment.isWSL ? ' | WSL ' + inline(safe.environment.wslVersion ?? '?') : ''}`, ''];
  if (safe.project?.root) lines.push(`Project: ${inline(safe.project.root)}`, '');
  if (safe.command === 'which' && safe.data.commands?.length) {
    lines.push(`External ${safe.environment.platform === 'win32' ? 'PATH/PATHEXT' : 'PATH'} lookup only; aliases, functions, and shell caches are not inspected.`, '');
    for (const command of safe.data.commands) {
      lines.push(`${inline(command.name)} -> ${command.selected ? inline(command.selected) : command.complete === false ? '(unconfirmed; inspection incomplete)' : '(not found on PATH)'}`);
      for (const candidate of command.candidates ?? []) lines.push(`  ${candidate.path === command.selected ? '*' : '-'} ${inline(candidate.path)}${candidate.realPath && candidate.realPath !== candidate.path ? ' -> ' + inline(candidate.realPath) : ''}${candidate.kind ? ' [' + inline(candidate.kind) + ']' : ''}${candidateQualifier(candidate)}`);
      if (command.complete === false) lines.push('  Inspection incomplete; selection could not be fully confirmed.');
      lines.push('');
    }
  }
  if (safe.command === 'ports' && safe.data.listeners?.length) {
    lines.push('ADDRESS                         PORT    PID     PROCESS');
    for (const item of safe.data.listeners.slice(0, 100)) lines.push(`${inline(item.address).padEnd(31)} ${String(item.port).padEnd(7)} ${String(item.pid ?? '?').padEnd(7)} ${inline(item.process ?? '(ownership unavailable)')}`);
    if (safe.data.listeners.length > 100) lines.push(`${safe.data.listeners.length - 100} more listeners; use --json for the complete observed inventory.`);
    lines.push('');
  }
  for (const check of checks) {
    lines.push(`${color(check.status.toUpperCase().padEnd(4), colors[check.status])}  ${inline(check.title)}  [${inline(check.id)}]`);
    if (check.detail) lines.push(`      ${inline(check.detail)}`);
    for (const item of check.evidence ?? []) lines.push(`      - ${inline(item)}`);
    if (check.remedy) lines.push(`      Next: ${inline(check.remedy)}`);
    lines.push('');
  }
  lines.push(summary);
  lines.push(options.redact === false ? 'Path redaction disabled.' : 'Home/project paths masked. Use --no-redact for exact local paths.');
  return lines.join('\n') + '\n';
}

export async function readSnapshot(filename) {
  if (!(await lstat(filename)).isFile()) throw new Error('Snapshot must be a regular file, not a directory, link, or device.');
  const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  const handle = await open(filename, flags);
  let text;
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > MAX_REPORT_BYTES) throw new Error('Snapshot must be a regular file no larger than 4 MiB.');
    const buffer = Buffer.alloc(MAX_REPORT_BYTES + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, null);
      if (!bytesRead) break;
      offset += bytesRead;
    }
    if (offset > MAX_REPORT_BYTES) throw new Error('Snapshot exceeds 4 MiB.');
    text = buffer.subarray(0, offset).toString('utf8').replace(/^\uFEFF/u, '');
  } finally { await handle.close(); }
  let report;
  try { report = JSON.parse(text); } catch { throw new Error('Snapshot is not valid JSON.'); }
  if (report?.schemaVersion !== 1 || report?.tool?.name !== 'wslens' || !Array.isArray(report.checks) || report.checks.length > 2000 || typeof report.command !== 'string') {
    throw new Error('Expected a WSLens schemaVersion 1 JSON diagnostic report.');
  }
  const ids = new Set();
  for (const check of report.checks) {
    if (!check || typeof check.id !== 'string' || ids.has(check.id) || !STATUSES.includes(check.status) || typeof check.title !== 'string'
      || (check.detail !== undefined && typeof check.detail !== 'string')
      || (check.evidence !== undefined && (!Array.isArray(check.evidence) || check.evidence.some(item => typeof item !== 'string')))) {
      throw new Error('Snapshot contains an invalid or duplicate finding.');
    }
    ids.add(check.id);
  }
  return report;
}

export function compareSnapshots(before, after) {
  if (before.command !== after.command) throw new Error('Compare reports made with the same command.');
  const old = new Map(before.checks.map(check => [check.id, check]));
  const current = new Map(after.checks.map(check => [check.id, check]));
  const added = [], removed = [], changed = [];
  const identity = check => JSON.stringify([check.status, check.title, check.detail ?? '', check.evidence ?? [], check.remedy ?? '']);
  for (const [id, check] of current) {
    if (!old.has(id)) added.push(check);
    else if (identity(old.get(id)) !== identity(check)) changed.push({ id, before: old.get(id), after: check });
  }
  for (const [id, check] of old) if (!current.has(id)) removed.push(check);
  return { schemaVersion: 1, tool: { name: 'wslens', version: VERSION }, command: 'diff', comparedCommand: before.command,
    added, removed, changed, unchanged: after.checks.length - added.length - changed.length };
}

export function renderDiff(diff, format, options = {}) {
  const safe = sanitize(diff, options);
  if (format === 'json') return JSON.stringify(safe, null, 2) + '\n';
  const esc = format === 'markdown' ? markdown : inline;
  const lines = [format === 'markdown' ? '# WSLens report comparison' : 'WSLens report comparison', '',
    `${safe.added.length} added | ${safe.removed.length} removed | ${safe.changed.length} changed | ${safe.unchanged} unchanged`, ''];
  for (const check of safe.added) lines.push(`+ ${esc(check.id)}: ${esc(check.status)} — ${esc(check.title)}`);
  for (const check of safe.removed) lines.push(`- ${esc(check.id)}: ${esc(check.status)} — ${esc(check.title)}`);
  for (const change of safe.changed) {
    lines.push(`~ ${esc(change.id)}: ${esc(change.before.status)} -> ${esc(change.after.status)}`);
    if (change.before.title !== change.after.title) lines.push(`  Before title: ${esc(change.before.title)}`, `  After title: ${esc(change.after.title)}`);
    if (change.before.detail !== change.after.detail) lines.push(`  Before: ${esc(change.before.detail ?? '')}`, `  After: ${esc(change.after.detail ?? '')}`);
    if ((change.before.remedy ?? '') !== (change.after.remedy ?? '')) lines.push(`  Before remedy: ${esc(change.before.remedy ?? '(none)')}`, `  After remedy: ${esc(change.after.remedy ?? '(none)')}`);
    const beforeEvidence = change.before.evidence ?? [], afterEvidence = change.after.evidence ?? [];
    if (JSON.stringify(beforeEvidence) !== JSON.stringify(afterEvidence)) {
      lines.push(`  Before evidence: ${beforeEvidence.map(esc).join('; ') || '(none)'}`, `  After evidence: ${afterEvidence.map(esc).join('; ') || '(none)'}`);
    }
  }
  if (!safe.added.length && !safe.removed.length && !safe.changed.length) lines.push('No finding changes. Timestamps and tool versions are ignored.');
  return lines.join('\n') + '\n';
}
