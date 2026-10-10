# Architecture and implementation contract

WSLens is a dependency-free Node.js 22+ command-line tool. It does not require an
API key, a service, an account, elevated privileges, or a configuration file.
The target is project portability and executable resolution across Windows/WSL,
with useful Linux/macOS fallbacks. It is not a WSL lifecycle manager.

## Modules

- `src/environment.mjs`: collect platform/mount metadata and environment checks.
- `src/which.mjs`: list PATH candidates and explain resolution without execution.
- `src/project.mjs`: bounded project portability checks, using Git index paths
  when a trusted Git executable is available and a bounded scan otherwise.
- `src/ports.mjs`: current-namespace TCP listeners and explicit loopback probes.
- `src/paths.mjs`: pure Windows/WSL path translation with explicit assumptions.
- `src/process.mjs`: bounded subprocess execution using fixed trusted system paths.
- `src/report.mjs`: stable JSON envelope, redaction, terminal/Markdown escaping,
  and snapshot comparison. No full environment or command-line dumps.
- `src/cli.mjs` and `bin/wslens.mjs`: argument validation, orchestration, output,
  exit codes, and a small executable entrypoint.

## Shared contracts

All check modules return findings with this shape:

```js
{
  id: 'project.script-crlf',
  status: 'warn', // pass | info | warn | fail | skip
  title: 'Unix scripts contain CRLF line endings',
  detail: 'What was observed and why it matters.',
  evidence: ['relative/file.sh'],
  remedy: 'A precise, optional manual next step.',
  docs: 'https://official.example/documentation'
}
```

Modules export:

```js
// environment.mjs
async function collectEnvironment(options = {}) // platform, arch, release,
// isWSL, wslVersion (1|2|null), distro, home, cwd, pathValue, pathExt, mounts
function environmentChecks(environment) // Finding[]

// which.mjs
async function inspectCommands(names, environment) // { checks, commands }
// commands: [{ name, selected: string|null, complete, candidates: [{path,
// realPath, kind, executable, matchesName, pathIndex, shellDependent?}], note }]
async function inspectPath(environment) // { checks, entries }

// project.mjs
async function inspectProject(root, environment, options = {})
// { checks, project: { root, source, scannedFiles, truncated, ... } }
// options.run = imported runSystem by default; other injection is module-owned

// ports.mjs
async function inspectPorts({ port, probe = false, environment, run } = {})
// { checks, listeners: [{address, port, pid: number|null, process: string|null,
// family: 'IPv4'|'IPv6'}], probes: [...], source }

// process.mjs
async function runSystem(name, args, options = {})
// { ok, stdout, stderr, code, error?, unavailable? }
// options: cwd, timeoutMs, maxBuffer, platform, env
```

Use pure helpers and injected I/O for platform fixtures. Tests live in `test/`
and use `node:test` + `node:assert/strict`; there are no test dependencies.
Every finding ID should occur at most once in a report. Aggregate repeated
findings with a bounded evidence list and total counts. Never present incomplete
inspection as a clean pass. Missing optional tools in the doctor inventory are
informational; an explicitly unresolved `which` request is a failure.

## Safety and limits

No arbitrary shell interpolation. No execution of discovered runtime binaries,
project scripts, Git hooks, package-manager scripts, or shell profiles. Read
only small, bounded headers of plausible Unix scripts, never `.env` files or
private keys. Do not follow project symlinks. Set subprocess timeouts/output
limits. `ports --probe` may open loopback TCP connections only; all other
commands are network-free. Port inspection covers the current network
namespace; it cannot prove connectivity from the Windows host into WSL.

Default diagnostic reports redact home and project roots. Path translation is
an exact local utility and its output must remain unredacted. `--no-redact` is
an explicit report opt-out. Rendering removes terminal escape/control codes and
escapes Markdown metacharacters. Snapshot comparison validates schema and size.

## Delivery

The user supplied an empty public repository; no template initializer or
generated metadata existed. Applicable workflow/issue/skill policies were
adapted directly from the current project-template. Product changes stay on
`feature/1-wslens`; merging follows `docs/git-workflow.md`.

Native Windows/WSL verification is distinct from injected Windows fixtures.
Record available and unavailable validation honestly. npm publication and
external hosting are outside this implementation's delivery scope.
