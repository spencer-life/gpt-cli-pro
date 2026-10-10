# CLI reference

WSLens requires Node.js 22 or newer. Use `wslens --help` for built-in help and
`wslens --version` for the package version. Unknown, duplicate, or irrelevant
options are errors. Paths with spaces need shell quoting.

## Commands

| Command | Input | Default output |
| --- | --- | --- |
| `doctor [directory]` | Optional project directory; defaults to cwd | Text diagnosis |
| `report [directory]` | Same checks as doctor | Markdown diagnosis |
| `which name [names...]` | 1–20 external command names | Candidate paths and findings |
| `ports [port]` | Optional single TCP port | Visible local listeners |
| `path absolute-path` | One supported Windows or Linux path | Translated path |
| `diff before.json after.json` | Two WSLens schema 1 diagnostic reports | Finding changes |

`report` stores `command: "doctor"` in its report envelope because its inspection
scope is identical. Markdown files are for reading; JSON files are for `diff`.

## Common report options

| Option | Meaning |
| --- | --- |
| `--json` | Equivalent to `--format json` |
| `--format`, `-f` | `text`, `json`, or `markdown`; path supports text/JSON only |
| `--output`, `-o` | Create a new output file; never overwrite |
| `--no-redact` | Include exact paths in diagnostic/diff output; unavailable for path |
| `--no-color` | Disable text ANSI colors; `NO_COLOR` and non-TTY output also disable them |
| `--strict` | Doctor/report/which/ports exit 1 for warnings in addition to failures |

Diagnostics do not write files unless `--output` is supplied. Ordinary shell
redirection is also possible, but overwrite behavior then belongs to the shell.

## Doctor and report

`--project directory` is an alternative to the positional directory; do not pass
both. `--tools node,npm,git` customizes the optional executable inventory. The
default list is `git,node,npm,python,python3` and missing default tools are not
treated as broken installations. Names cannot be paths or shell expressions.

`--port 3000` adds passive listener inspection. Add `--probe` only when you want
actual loopback TCP connections. A probe requires an explicit numeric port.

Project scope is either tracked Git paths under the selected directory or an
explicitly disclosed fallback directory scan. Subdirectories of a Git project
can be inspected separately. Findings reflect worktree script headers, not just
the staged blob contents. An explicit project root that is a symlink or Windows
junction is rejected; pass its real directory to inspect that target. The
[check catalog](checks.md) defines limits.

## Which

`which` searches inherited PATH in order. Its selection is an **external-file
selection**, not a reimplementation of every parent shell. It inspects executable
bits/access on POSIX and PATHEXT extensions/case on Windows. A PATH entry can
contain a shim or symlink; both are described without execution. PowerShell's
`.ps1` preference can differ from the PATHEXT selection; related script candidates
are labeled with a shell-specific note.

An inaccessible earlier search directory can make selection unconfirmed even
when a later candidate is visible. JSON distinguishes `selected`, `observedFirst`,
and `complete`. A candidate's `matchesName: false` means a related name, not a
candidate this model would execute. Symlink targets appear as `realPath`.

For parent-shell state, use that shell's own `type`/`command -V`. In PowerShell,
`Microsoft.PowerShell.Core\Get-Command -Name 'node' -All -ListImported` inspects
the current session without importing other modules; substitute the requested
command name. Unimported module commands remain unassessed. An unrestricted
exact-name query can import a module and run its scripts, as described in
[Get-Command](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-command?view=powershell-5.1).
WSLens does not run these shell queries for you.

## Ports

Pass `ports 3000` or `ports --port 3000`; not both. Valid ports are integers
1–65535. Without a filter, the CLI lists visible TCP listeners. UDP is outside
this command. Text output displays at most 100 observed listeners; JSON retains
the bounded full inventory.

Probes use only `127.0.0.1` and `::1`, no DNS, and a 500 ms timeout per address.
`reachable` means a TCP connection succeeded in this process's namespace.
`refused`/`timeout` are observations, not proof that a port is free or an app is
healthy. No process is killed and no firewall, forwarding, or service setting changes.

WSL NAT and mirrored networking have different host/guest behavior; consult
[Microsoft's networking guide](https://learn.microsoft.com/en-us/windows/wsl/networking)
when a server works in one environment but not the other.

## Path

| Option | Meaning |
| --- | --- |
| `--to windows` / `--to wsl` | Output path form; otherwise inferred from input |
| `--mount-root /windows` | Override conventional `/mnt` drive mapping |
| `--distro Ubuntu` | Distribution for Linux-native paths; defaults to `WSL_DISTRO_NAME` |
| `--quote bash` / `--quote powershell` | Return the translated path as one quoted shell argument |

Supported inputs are absolute drive paths such as `C:\dev\app`, WSL UNC paths
such as `\\wsl.localhost\Ubuntu\home\ada`, and absolute Linux paths. Relative
paths, generic SMB shares, extended/device namespaces, control characters, and
ambiguous backslashes in Linux paths are rejected. Reserved Windows drive names
cannot be synthesized from Linux paths.

Conversions are lexical. WSLens does not verify mounts or launch another
distribution. `--mount-root` is required when the assumed drive layout differs
from the actual layout. Shell quoting does not execute or open the resulting path.
PowerShell quoting handles ASCII and typographic single quotation marks according
to [PowerShell's rules](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_quoting_rules).

## Diff

Snapshots must be regular JSON files, at most 4 MiB each, with `schemaVersion: 1`,
`tool.name: "wslens"`, the same diagnostic command, and valid unique finding IDs.
Symlink and device inputs are rejected. UTF-8 BOMs are accepted.

Comparison covers finding status, title, detail, evidence, and remedy. It ignores
timestamps and tool-version metadata. It compares findings rather than every
inventory field: a data-only change does not necessarily produce a diff. Use
the same command options and project scope for meaningful comparisons.

Added, removed, and changed findings are separate. A removed finding is not
automatically a fixed problem; the scope or inspection availability may differ.
Default rendering masks known recorded project roots even for unredacted inputs.

## JSON and exit status

Diagnostic reports contain `schemaVersion`, `tool`, `command`, `generatedAt`,
`environment`, optional `project`, `checks`, `summary`, `data`, and `privacy`.
Project reports include the boolean `privacy.projectRootCaseInsensitive` as a
masking policy for later diffs, including in raw exports. Each input's project
root uses its own recorded policy; a diff does not infer the source filesystem
from the machine reading it. See [redaction details](privacy.md#report-redaction).

Finding IDs are stable identifiers within schema 1; statuses are `fail`, `warn`,
`info`, `pass`, and `skip`. Additive fields may appear in later versions.

| Exit | Diagnostic command | Diff |
| --- | --- | --- |
| 0 | No failures; warnings permitted unless strict | No finding changes |
| 1 | Failure, unresolved explicit command, or strict warning | At least one finding change |
| 2 | Invalid input, I/O/operation error, 20-second global deadline | Invalid/incompatible snapshots or I/O error |

On argument or operation errors, a concise message goes to stderr and stdout
stays empty unless an output operation itself was interrupted. No JSON-looking
success object is emitted for an error.
