# WSLens

**Understand why your project works on one side of Windows and WSL but fails on the other.**

WSLens connects the evidence: a Windows runtime selected inside WSL, a slow
filesystem boundary, a shell script with CRLF, colliding filenames, or a port
already occupied by another process. Each finding explains what was observed
and gives a focused next step.

Local by default. No API key, account, telemetry, third-party dependencies,
installation scripts, or automatic system changes. Works with **Node.js 22+**.

## Start here

Install from this repository once the initial implementation PR is merged:

```sh
npm install --global --ignore-scripts git+https://github.com/spencer-life/gpt-cli-pro.git
wslens doctor
```

For the initial review build, use the exact branch or commit install command
in the implementation PR. The package has not been published to the npm registry.

Or run directly from a checkout, with no installation:

```sh
node bin/wslens.mjs doctor
```

Run inside the project and environment that is misbehaving. Run once in WSL and
once in Windows when comparing both sides; one process does not see both environments.

## What you can do

| Problem | Command |
| --- | --- |
| “Something is wrong with this setup.” | `wslens doctor` |
| “Which Node/Python/Git am I actually finding?” | `wslens which node npm python git` |
| “Why can’t my dev server use port 3000?” | `wslens ports 3000` |
| “Can this environment connect to that port?” | `wslens ports 3000 --probe` |
| “I need the same path on the other side.” | `wslens path 'C:\Users\Ada\My app'` |
| “Give my teammate or coding agent the evidence.” | `wslens report --output diagnostic.md` |
| “Did that fix actually change anything?” | `wslens diff before.json after.json` |

### Diagnose a project

```sh
wslens doctor
wslens doctor ./my-project --tools node,npm,git --port 3000
wslens doctor --json --output before.json
# Make your own reviewed fix, then collect another report:
wslens doctor --json --output after.json
wslens diff before.json after.json
```

An illustrative finding looks like this:

```text
FAIL  Unix script headers contain CRLF line endings  [project.script-crlf]
      - scripts/start.sh
      Next: Use LF for Unix scripts and a targeted .gitattributes rule
      such as *.sh text eol=lf. Review the normalization diff before committing.
```

Try **`npm run demo`** from the checkout for a real, disposable example. It creates
a temporary project with deliberate problems, runs the CLI, then removes the fixture.

### Explain command resolution

```sh
wslens which node npm git
wslens which python python3 --json
wslens which node --no-redact
```

Shows candidates in PATH order, symlink targets, version-manager shims, Windows
extensions, and the selected external executable. Related `.exe` files inside
WSL are labeled explicitly: typing `node` in a POSIX shell does not automatically
select `node.exe`.

Missing tools in the default doctor inventory are informational. An explicitly
requested command that cannot be resolved makes `which` exit with code 1.
Aliases, functions, shell command caches, PowerShell execution policy, and
runtime versions are outside this file lookup. WSLens never runs the candidates.

### Inspect ports

```sh
wslens ports
wslens ports 3000
wslens ports 3000 --probe --json
```

Reports TCP listeners and, when visible, an owning PID and process name. Linux
and WSL use `/proc`; Windows uses a fixed PowerShell query with a `netstat`
fallback; macOS uses `lsof`. Process command lines are never collected.

`--probe` opens a short TCP connection to `127.0.0.1` and `::1`, sends no
application data, and requires an explicit port. Results describe the current
network namespace. They do not prove Windows-to-WSL forwarding or firewall access.

### Translate paths safely

```sh
wslens path 'C:\Users\Ada\My app' --to wsl --quote bash
# '/mnt/c/Users/Ada/My app'

wslens path /mnt/d/code/app --to windows --quote powershell
# 'D:\code\app'

wslens path /home/ada/app --distro Ubuntu
# \\wsl.localhost\Ubuntu\home\ada\app

wslens path 'D:\code\app' --mount-root /windows
# /windows/d/code/app
```

These are lexical conversions, not existence checks. The drive mount root
defaults to `/mnt`; set `--mount-root` if yours differs. Linux-native paths need
`--distro`, or `WSL_DISTRO_NAME` when running inside that distribution. Ambiguous
network shares, device paths, and relative paths are rejected. Path output stays
exact and unredacted so it can be used locally.

## Reports you can use in an issue or with an agent

```sh
wslens report --output diagnostic.md
wslens doctor --json --output diagnostic.json
```

Reports have stable finding IDs, evidence, remedies, source links, an explicit
status summary, and a versioned JSON envelope. Home and project roots are masked
by default. Use `--no-redact` only when you need exact local paths. No report is
uploaded. `--output` creates a new file and refuses to overwrite an existing one.

Redaction is not a promise that every filename or process name is anonymous.
Review exported reports before sharing. See [Privacy and safety](docs/privacy.md).

## Scope and limits

- Git projects inspect **indexed paths within the selected directory**. Untracked
  files are excluded and an empty index is reported explicitly. Without a trusted
  Git installation, a bounded directory scan excludes common dependency, build,
  cache, and sensitive paths.
- Script inspection reads small candidate headers, not whole repositories. Project
  symlink targets and submodule contents are not traversed.
- Explicit project-root symlinks and Windows junctions are rejected. Pass the real
  directory explicitly to inspect that target.
- WSL1/WSL2 and custom mounts are recognized from available evidence. Missing or
  incomplete data is reported; it does not become a clean pass.
- Windows tool discovery is PATH/PATHEXT based. ACLs and parent-shell resolution
  may differ. Mixed Windows/WSL installations can be intentional.
- Diagnosis is bounded; the executable has a 20-second overall deadline. An
  unresponsive network drive or denied access becomes a visible limitation.
- Node must already work well enough to run the CLI. This is a small diagnostic
  package, not a standalone native executable or a runtime installer.

## Exit codes

| Code | Meaning |
| --- | --- |
| `0` | No failed findings; warnings are allowed. For `diff`, no finding changed. |
| `1` | A failed finding, any warning with `--strict`, an unresolved explicit `which` request, or differences between snapshots. |
| `2` | Invalid arguments/input, an operation error, or the overall command deadline. |

Use `wslens doctor --strict --json` for an opt-in project check. Exit 0 is not a
claim that skipped inspections ran or that the whole machine is healthy.

## Development

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm run pack:check
```

The equivalent mise tasks are `mise run setup`, `mise run ci`, and
`mise run pack:check`. CI includes Linux, Windows, and macOS on Node 22/24, plus
Node 26 on Linux. See [validation](docs/validation.md) for observed results and
remaining native coverage; workflow configuration alone does not prove a pass.

Read the [full CLI reference](docs/cli.md), [check catalog](docs/checks.md),
[architecture](docs/architecture.md), [research and prior tools](docs/research.md),
and [contribution guide](CONTRIBUTING.md).

## Troubleshooting installation

If PowerShell blocks npm's script shim, use **`npm.cmd`** for installation and
**`wslens.cmd`** to run the installed CLI. No execution-policy change is necessary.
If a global installation reports a permission error, use a user-owned Node
installation or run from the checkout instead of adding administrator privileges.

For unsupported Git locations, project checks still run using the documented
filesystem fallback. WSLens intentionally does not execute an arbitrary `git`
found in a project's PATH. On Windows, only Git installations beneath the OS's
Program Files known folders are eligible; custom and per-user installations use
the fallback. System helper locations are established independently of inherited
environment paths. See [execution boundaries](docs/privacy.md#execution-and-modification-boundaries).

## License

[MIT](LICENSE).
