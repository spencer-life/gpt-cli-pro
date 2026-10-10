import { parseArgs } from 'node:util';
import { lstat, realpath, open } from 'node:fs/promises';
import path from 'node:path';
import { collectEnvironment, environmentChecks } from './environment.mjs';
import { inspectCommands, inspectPath } from './which.mjs';
import { inspectProject } from './project.mjs';
import { inspectPorts } from './ports.mjs';
import { convertPath, quotePath } from './paths.mjs';
import { VERSION, cleanText, sanitize, makeReport, renderReport, reportExitCode, readSnapshot, compareSnapshots, renderDiff } from './report.mjs';

const HELP = `WSLens ${VERSION} — make Windows/WSL development problems explain themselves.

Usage: wslens <command> [arguments] [options]

Commands:
  doctor [directory]        Diagnose project portability, filesystem, and PATH
  report [directory]        The same diagnosis, formatted as shareable Markdown
  which <name> [names...]   List external executable candidates in PATH order
  ports [port]             Inspect TCP listeners in this network namespace
  path <absolute-path>     Translate a Windows or WSL path
  diff <before> <after>    Compare two JSON diagnostic reports

Report options:
  --json                   Output structured JSON (schemaVersion 1)
  --format text|json|markdown
  --output, -o <file>       Save to a new file (refuses to overwrite)
  --no-redact              Include exact local paths in diagnostic reports
  --no-color               Disable ANSI colors (also respects NO_COLOR)
  --strict                 Exit 1 for warnings as well as failures

Doctor/report options:
  --project <directory>    An alternative to the positional directory
  --tools <names>          Comma-separated tool names (default: git,node,npm,python,python3)
  --port <1-65535>         Include a local port check
  --probe                 Explicitly connect to that port on IPv4/IPv6 loopback

Ports options:
  --port <1-65535>         An alternative to the positional port
  --probe                 Connect to the selected port on loopback only

Path options:
  --to windows|wsl         Default: infer the other form from the input
  --mount-root <path>      Windows drive automount root (default: /mnt)
  --distro <name>          Distribution for Linux-native paths, e.g. Ubuntu
  --quote bash|powershell  Quote the resulting path for a chosen shell

Examples:
  wslens doctor
  wslens doctor . --port 3000 --probe
  wslens which node npm git
  wslens report --output diagnostic.md
  wslens doctor --json --output before.json
  wslens diff before.json after.json
  wslens path 'C:\\Users\\Ada\\My app' --to wsl --quote bash
  wslens path /home/ada/app --distro Ubuntu

Exit codes: 0 = no failures (warnings allowed); 1 = findings failed / strict
warnings / snapshots differ; 2 = invalid arguments, input, or operation error.
Diagnosis never changes settings or executes discovered runtimes/project scripts.
No network calls except the explicitly requested loopback --probe.
`;

const options = {
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' },
  json: { type: 'boolean' }, format: { type: 'string', short: 'f' },
  output: { type: 'string', short: 'o' }, strict: { type: 'boolean' },
  'no-redact': { type: 'boolean' }, 'no-color': { type: 'boolean' },
  project: { type: 'string' }, tools: { type: 'string' }, port: { type: 'string' }, probe: { type: 'boolean' },
  to: { type: 'string' }, 'mount-root': { type: 'string' }, distro: { type: 'string' }, quote: { type: 'string' },
};
const common = ['help', 'version', 'json', 'format', 'output', 'no-color'];
const commandOptions = {
  doctor: [...common, 'strict', 'no-redact', 'project', 'tools', 'port', 'probe'],
  report: [...common, 'strict', 'no-redact', 'project', 'tools', 'port', 'probe'],
  which: [...common, 'strict', 'no-redact'],
  ports: [...common, 'strict', 'no-redact', 'port', 'probe'],
  path: [...common, 'to', 'mount-root', 'distro', 'quote'],
  diff: [...common, 'no-redact'],
};

export function parseCLI(argv) {
  const parsed = parseArgs({ args: argv, options, allowPositionals: true, strict: true, tokens: true });
  const { values, positionals, tokens } = parsed;
  const repeated = new Set();
  for (const token of tokens.filter(token => token.kind === 'option')) {
    if (repeated.has(token.name)) throw new Error(`--${token.name} may only be specified once.`);
    repeated.add(token.name);
  }
  if (values.version) return { action: 'version' };
  if (values.help || positionals[0] === 'help' || argv.length === 0) return { action: 'help' };
  const [command, ...args] = positionals;
  if (!Object.hasOwn(commandOptions, command)) throw new Error(`Unknown command ${command ?? '(none)'}. Run wslens --help.`);
  for (const name of Object.keys(values)) if (!commandOptions[command].includes(name)) throw new Error(`--${name} does not apply to ${command}.`);
  if (values.json && values.format && values.format !== 'json') throw new Error('--json conflicts with --format.');
  const format = values.json ? 'json' : (values.format ?? (command === 'report' ? 'markdown' : 'text'));
  if (!['text', 'json', 'markdown'].includes(format)) throw new Error('--format must be text, json, or markdown.');
  if (command === 'path' && format === 'markdown') throw new Error('Path output supports text or JSON.');
  if (['doctor', 'report'].includes(command) && (args.length > 1 || (args.length && values.project))) throw new Error('Choose one project directory, as an argument or with --project.');
  if (command === 'which' && (!args.length || args.length > 20)) throw new Error('which requires between 1 and 20 command names.');
  if (command === 'ports' && (args.length > 1 || (args.length && values.port))) throw new Error('Choose one port, as an argument or with --port.');
  if (command === 'path' && args.length !== 1) throw new Error('path requires one absolute path; quote paths containing spaces.');
  if (command === 'diff' && args.length !== 2) throw new Error('diff requires before.json and after.json.');
  const portInput = command === 'ports' ? (args[0] ?? values.port) : values.port;
  let port;
  if (portInput !== undefined) {
    if (!/^\d{1,5}$/u.test(portInput) || Number(portInput) < 1 || Number(portInput) > 65535) throw new Error('Port must be an integer from 1 through 65535.');
    port = Number(portInput);
  }
  if (values.probe && port === undefined) throw new Error('--probe requires an explicit port.');
  const names = command === 'which' ? args : (values.tools !== undefined ? values.tools.split(',') : ['git', 'node', 'npm', 'python', 'python3']);
  if (['which', 'doctor', 'report'].includes(command)) {
    if (names.length > 20 || names.some(name => !/^[a-zA-Z0-9][a-zA-Z0-9_.+-]{0,127}$/u.test(name))) throw new Error('Tool names must be simple command names (up to 20), not paths or shell expressions.');
  }
  if (values.output !== undefined && !values.output.trim()) throw new Error('--output requires a filename.');
  return { command, args, values, format, port, names: [...new Set(names)] };
}

async function emit(text, filename, stdout) {
  if (filename) {
    const handle = await open(filename, 'wx', 0o600);
    try { await handle.writeFile(text, 'utf8'); } finally { await handle.close(); }
  } else {
    await new Promise((resolve, reject) => stdout.write(text, error => error ? reject(error) : resolve()));
  }
}

export async function main(argv = process.argv.slice(2), io = {}) {
  const stdout = io.stdout ?? process.stdout, stderr = io.stderr ?? process.stderr;
  const env = io.env ?? process.env;
  try {
    const parsed = parseCLI(argv);
    if (parsed.action) {
      await emit(parsed.action === 'help' ? HELP : VERSION + '\n', null, stdout);
      return 0;
    }
    const { command, args, values, format, port, names } = parsed;
    if (command === 'path') {
      const translated = convertPath(args[0], { to: values.to, mountRoot: values['mount-root'], distro: values.distro ?? env.WSL_DISTRO_NAME });
      const quoted = values.quote ? quotePath(translated, values.quote) : null;
      const result = format === 'json' ? JSON.stringify({ schemaVersion: 1, tool: { name: 'wslens', version: VERSION }, command, input: args[0], output: translated,
        ...(quoted ? { quoted } : {}), mapping: 'lexical', mountRoot: values['mount-root'] ?? '/mnt' }, null, 2) + '\n' : (quoted ?? translated) + '\n';
      await emit(result, values.output, stdout);
      return 0;
    }
    if (command === 'diff') {
      const [before, after] = await Promise.all(args.map(readSnapshot));
      const home = env.HOME ?? env.USERPROFILE;
      const redact = !values['no-redact'];
      const diff = compareSnapshots(sanitize(before, { home, project: before.project?.root, redact }), sanitize(after, { home, project: after.project?.root, redact }));
      await emit(renderDiff(diff, format, { redact: !values['no-redact'], home }), values.output, stdout);
      return diff.added.length || diff.removed.length || diff.changed.length ? 1 : 0;
    }
    let root;
    if (['doctor', 'report'].includes(command)) {
      root = path.resolve(values.project ?? args[0] ?? io.cwd ?? process.cwd());
      const info = await lstat(root);
      if (info.isSymbolicLink()) throw new Error('Project root must not be a symlink or junction. Pass its real directory explicitly.');
      if (!info.isDirectory()) throw new Error('Project path must be a directory.');
      root = await realpath(root);
    }
    const environment = await collectEnvironment({ env, cwd: root ?? io.cwd ?? process.cwd() });
    let report;
    if (command === 'which') {
      const result = await inspectCommands(names, environment);
      const missing = result.commands.filter(item => !item.selected);
      if (missing.length) result.checks.push({ id: 'which.requested-unresolved', status: 'fail', title: 'Requested commands have no confirmed PATH selection', detail: 'Some commands were missing or could not be resolved conclusively because inspection was incomplete.', evidence: missing.map(item => `${item.name}: ${item.complete === false ? 'inspection incomplete' : 'no executable found'}`), remedy: 'Check missing tools, PATH entries, and any inspection limits; shell aliases and functions are outside this scan.' });
      report = makeReport('which', environment, result.checks, { commands: result.commands });
    } else if (command === 'ports') {
      const result = await inspectPorts({ port, probe: Boolean(values.probe), environment });
      report = makeReport('ports', environment, result.checks, { listeners: result.listeners, probes: result.probes, source: result.source });
    } else {
      const [paths, commands, project, ports] = await Promise.all([
        inspectPath(environment), inspectCommands(names, environment), inspectProject(root, environment),
        port === undefined ? Promise.resolve(null) : inspectPorts({ port, probe: Boolean(values.probe), environment }),
      ]);
      report = makeReport('doctor', environment, [...environmentChecks(environment), ...paths.checks, ...commands.checks, ...project.checks, ...(ports?.checks ?? [])],
        { commands: commands.commands, pathEntries: paths.entries, ...(ports ? { listeners: ports.listeners, probes: ports.probes, portSource: ports.source } : {}) }, project.project);
    }
    const redaction = { home: environment.home, project: root, redact: !values['no-redact'], color: Boolean(stdout.isTTY && env.NO_COLOR === undefined && !values['no-color'] && env.TERM !== 'dumb') };
    await emit(renderReport(report, format, redaction), values.output, stdout);
    return reportExitCode(report, values.strict);
  } catch (error) {
    if (error.code === 'EPIPE') return 0;
    const detail = error.code === 'EEXIST' ? 'Output file already exists. Choose a new filename; WSLens does not overwrite files.'
      : error.code === 'ENOENT' ? 'A requested file or directory does not exist.'
        : error.code === 'EACCES' || error.code === 'EPERM' ? 'Permission denied while accessing the requested path.'
          : error.message;
    stderr.write('WSLens: ' + cleanText(detail).replaceAll('\n', ' ') + '\n');
    return 2;
  }
}
