# WSLens command guidance

Examples assume a trusted `wslens` installation. Substitute `wslens.cmd` in
PowerShell if needed, or `node` followed by the quoted absolute path to a known
checkout's `bin/wslens.mjs`. Run in the target project and environment. A skill
copied to another project still needs an accessible CLI.

## Project diagnosis and reports

```sh
wslens doctor . --json
wslens doctor ./my-project --tools node,npm,git --json
wslens report . --output diagnostic.md
wslens doctor . --json --output before.json
```

`doctor` and `report` run the same inspections; `report` defaults to Markdown
and records `command: "doctor"` in JSON. `--project directory` is an alternative
to the positional directory, not an additional scope. `--tools` is a
comma-separated list of command names, not executable paths or shell syntax.
Missing default inventory tools are informational; use `which` for an explicit
missing-command question.

Project checks inspect indexed Git paths beneath the selected directory. An
empty index or untracked file is not evidence of a clean whole directory. If a
trusted Git installation is unavailable, the report discloses a bounded
filesystem fallback with exclusions. Script checks read short headers. They
do not execute scripts, traverse project symlink targets, or prove application
correctness. An explicit symlink or junction project root is rejected; use a
real directory only when it is the intended target. Report scan limits as
limits, including when an individual inspected subset passes.

`--output` creates a new file and refuses to replace an existing one. Use a
fresh filename for another capture; do not delete an old report just to retry.
Keep default redaction for shareable output. `--no-redact` is available when
exact local paths are needed; filenames and process names can remain
identifying even in redacted reports. `--strict` makes warnings affect the
exit status; reserve it for a requested gate rather than everyday triage.

## PATH and runtime selection

```sh
wslens which node npm git --json
wslens which python python3 --json
```

Look at `data.commands`: each command has `selected`, `observedFirst`,
`complete`, and `candidates`. A visible candidate is not always a confirmed
selection. `complete: false` means some inspection was unavailable; a null
`selected` then cannot prove that the tool is absent. A nonnull selection can
still be confirmed before a later incomplete PATH entry. Very large JSON
reports may omit later candidates to stay within the 4 MiB snapshot limit;
check `report.snapshot-limited`, `data.inventoryLimit`, and per-command
`candidatesTruncated` before treating candidate arrays as exhaustive. A candidate with
`matchesName: false` is a related name, not the requested executable. `realPath`
describes a symlink target when visible.

The CLI models external PATH/PATHEXT lookup. It does not execute candidates or
determine their versions, architecture, aliases, shell functions, cached
resolution, ACL behavior, or PowerShell execution policy. WSL does not append
`.exe` automatically: finding `node.exe` does not mean `node` selects it.
When actual parent-shell selection matters, suggest or use the user's shell's
`type` / `command -V` within the task's scope. For PowerShell, use a query that
does not import modules, for example:

```powershell
Microsoft.PowerShell.Core\Get-Command -Name 'node' -All -ListImported
```

Substitute the requested literal command name. Unimported module commands stay
outside this lookup. An unrestricted exact-name `Get-Command` can import a
module and execute its scripts, so do not use it as a passive inspection of an
untrusted environment. See Microsoft's
[Get-Command reference](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/get-command?view=powershell-5.1).

## Local TCP ports

```sh
wslens ports 3000 --json
wslens ports 3000 --probe --json
wslens doctor . --port 3000 --json
```

Start with passive listener inspection. `data.listeners` contains visible
listeners with owning PID/process name when available. No listener in an
incomplete inventory is inconclusive; the output does not promise a port will
remain free. UDP is outside this command.

Use `--probe` when the requested task calls for an actual connection test. It
requires one explicit port, connects to `127.0.0.1` and `::1`, sends no
application data, and times out after 500 ms per address. `data.probes` reports
TCP reachability, not HTTP responses or application health. A refused or timed
out connection is not proof of a free port. All observations concern the
current network namespace. A successful WSL loopback probe does not establish
Windows-to-WSL forwarding or firewall access. Compare runs on both sides when
both are available; otherwise state the missing observation. Never kill an
owner merely because its PID appears in a report.

## Windows and WSL paths

```sh
wslens path 'C:\Users\Ada\My app' --to wsl --quote bash
wslens path /mnt/d/code/app --to windows --quote powershell
wslens path /home/ada/app --to windows --distro Ubuntu
wslens path 'D:\code\app' --to wsl --mount-root /windows
```

Conversion is lexical: it does not check existence, mount configuration, or
distribution installation. Drive mapping assumes `/mnt` unless `--mount-root`
is supplied. Linux-native paths need `--distro` or the current
`WSL_DISTRO_NAME`; do not guess a distribution. `--quote` chooses the output
shell's argument quoting, not the input shell. The converted path stays exact
and unredacted. Do not evaluate the output as a command.

Relative paths, generic network shares, and device namespaces are rejected.
`path --json` returns `input` and `output` rather than diagnostic `checks`.
It does not accept `--strict` or `--no-redact`.

## Before and after

```sh
wslens doctor . --json --output before.json
# After a separately requested or already authorized fix:
wslens doctor . --json --output after.json
wslens diff before.json after.json --json
```

Use matching project scope and command options. Inputs must be regular WSLens
schema 1 JSON diagnostic files, at most 4 MiB each, with the same diagnostic
command. Generated diagnostic JSON follows the same limit, omitting optional
inventory tails with an explicit warning rather than producing an unreadable
snapshot. Imported command identities must be exactly `doctor`, `which`, or
`ports` (`report` exports `doctor`); control-character variants are rejected
before comparison. Markdown and path/diff JSON are not diagnostic snapshots.

Diff JSON separates `added`, `removed`, and `changed` findings. Compare status
and evidence to decide whether a change improved the situation. A removed
finding can reflect changed scope or lost visibility. A diff with no changes
only means the compared findings matched: timestamps and tool-version metadata
are ignored, and changes confined to inventory `data` do not count. Read the
original reports when those details matter.

## Output options

`--json` equals `--format json`; choose one. Diagnostics and diffs also support
`--format text` and `--format markdown`; `path` supports text and JSON.
`--no-color` disables text colors. Unknown, duplicate, and command-irrelevant
options are errors, so check the installed `--help` before assuming additional
flags. Argument and operation errors go to stderr, not a diagnostic JSON
success object.
