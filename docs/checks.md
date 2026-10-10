# Checks and interpretation

WSLens reports observable conditions in the environment that runs it. Findings
identify useful leads; they do not certify that an application will build or run.
Each finding ID appears at most once per report, with repeated examples grouped.

## Statuses

| Status | Meaning |
| --- | --- |
| `pass` | The stated check succeeded within its inspected scope. Read any separate incomplete-scan finding. |
| `info` | Context or an intentional configuration worth understanding; no repair is assumed necessary. |
| `warn` | A possible portability problem, ambiguity, or inspection limit needs attention. |
| `fail` | A concrete execution hazard was found, or an explicitly requested command could not be resolved. |
| `skip` | This check had insufficient evidence, no applicable input, or an unavailable optional capability. |

A diagnostic exits with code `1` for `fail`; `--strict` also treats `warn` as `1`.
Missing optional default tools are informational. Invalid arguments and command
errors use code `2`. An absent finding is not evidence that its check passed.

## Environment and filesystem placement

| Finding ID | Status | What it establishes; useful next step |
| --- | --- | --- |
| `environment.platform` | info | Current process platform, architecture, kernel, and available WSL markers. WSL presence does not always identify its version. |
| `environment.windows-filesystem` | warn / info | A matching mount identifies a Windows filesystem, or a conventional drive path suggests one. For Linux tooling with heavy file I/O, consider a working copy inside the distribution filesystem. |
| `environment.linux-filesystem` | pass | A recognized Linux mount contains the resolved working directory. This does not benchmark its performance. |
| `environment.wsl-network-path` | info | Windows is accessing the folder through a WSL share. Keep the runtime and working files on the same side when performance matters. |
| `environment.filesystem-unknown` | skip | The real working directory or matching filesystem could not be established. Resolve the path or inspect the mount before drawing conclusions. |
| `environment.mounts-incomplete` | warn | Mount metadata reached a size/count limit; a more specific mount may be missing. Check the operating system mount inventory. |
| `environment.incomplete` | warn | Environment filesystem I/O timed out. Check disconnected drives or mounts, then repeat the diagnosis. |

Mount metadata takes precedence over `/mnt/<drive>` guesses. A Linux mount nested
inside `/mnt/c`, or a custom Windows automount root, is handled by the longest
matching mount. Moving a working copy is optional; preserve uncommitted work.
See Microsoft's [filesystem guidance](https://learn.microsoft.com/en-us/windows/wsl/filesystems)
and [WSL configuration](https://learn.microsoft.com/en-us/windows/wsl/wsl-config).

## PATH hygiene

| Finding ID | Status | What it establishes; useful next step |
| --- | --- | --- |
| `path.unset` | warn | The inherited environment has no PATH. Inspect the terminal/editor configuration that starts the process. |
| `path.empty` | warn | Empty segments exist. POSIX searches the current directory for an empty segment; this Windows PATH-only model ignores it. Remove accidental separators. |
| `path.relative` | warn | A directory depends on the working directory or Windows current drive. Prefer an absolute, drive-qualified path. |
| `path.duplicates` | info | A normalized directory repeats earlier in PATH. Remove repetition if convenient; it does not prove a tool conflict. |
| `path.missing` | info | A PATH entry is absent or is not a directory. Check whether an installation was removed or a drive disconnected before deleting the entry. |
| `path.incomplete` | warn | Entries were inaccessible, malformed, unresolved, or outside a scan/time limit. Fix the named entry or shorten PATH, then rerun. |
| `path.clean` | pass | Inspected entries are existing absolute directories without duplicates. This does not verify their executables. |

Windows matching ignores case and supports surrounding double quotes, including
quoted semicolons. POSIX quotes inside PATH are literal characters. `C:tools`
is drive-relative; `\tools` depends on the current drive. Neither is equivalent
to `C:\tools`.

## Executable selection

| Finding ID | Status | What it establishes; useful next step |
| --- | --- | --- |
| `which.resolved` | pass | The first eligible external file was identified by PATH order and execute access/PATHEXT. Review its path and symlink target. |
| `which.missing` | info | A completed lookup found no eligible file for an optional tool. Install it only if the project needs it. |
| `which.multiple` | info | Distinct canonical candidates share a command name. Inspect the selected one; version-manager shims and wrappers are often intentional. |
| `which.nonexecutable` | warn / info | A matching file lacks execute access or a usable symlink target. Warn applies when no selected candidate exists; inspect the installation and permissions. |
| `which.windows-runtime` | warn | A selected runtime inside WSL has a Windows executable/script extension. Confirm that Windows interop is intended, or select a Linux toolchain. |
| `which.windows-filesystem` | warn | A selected development tool's real path lies on a confirmed Windows filesystem mount, including extensionless wrappers. Review its installation; location does not identify the interpreter or runtime architecture. Unknown or truncated mount evidence does not trigger this finding. |
| `which.powershell-script` | info | A `.ps1` candidate may change PowerShell selection independently of PATHEXT. Inspect `Get-Command <name> -All` in that session; no execution-policy or ACL verdict is inferred. |
| `which.nearby` | info | Related files exist but do not match this platform's lookup. WSL does not append `.exe`; Windows extensionless Unix wrappers are not PATHEXT executables. |
| `which.incomplete` | warn | A lookup limit, timeout, or inaccessible path prevents complete inspection. An observed candidate after an unreadable directory is not a confirmed selection. |
| `which.invalid-name` | warn | The engine rejected a non-bare, oversized, or control-containing name. The CLI applies stricter validation before inspection. |
| `which.requested-unresolved` | fail | Explicit `wslens which` requests include a missing or unconfirmed command. Read accompanying incomplete findings before assuming it needs installation. |

This is external-file lookup, not a connection to your interactive shell. Aliases,
functions, built-ins, cached shell resolutions, and implicit current-directory
searches are outside its scope. Compare with `Get-Command NAME -All` in PowerShell
or `type -a NAME` in Bash when shell behavior differs. See
[PowerShell command precedence](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_command_precedence)
and [Windows PATH/PATHEXT lookup](https://learn.microsoft.com/en-us/windows-server/administration/windows-commands/where).

Executables are never run: version, architecture, interpreter availability, and
application behavior remain unverified. Windows ACLs, file associations, and
PowerShell execution policy can impose additional restrictions. A related
candidate with `matchesName: false` is never selected, even if its execute bit is set.

Windows `selected` follows the PATH/PATHEXT model. When `npm.cmd` and `npm.ps1`
coexist, the report can select `npm.cmd` while showing the script as related;
PowerShell may choose the `.ps1` script instead of the selected PATHEXT candidate.
An explicit `.ps1` request outside PATHEXT is likewise observed without claiming
that the script is blocked or runnable. See Microsoft's [PowerShell script handling](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_environment_variables#path-information).

## Project portability

| Finding ID | Status | What it establishes; useful next step |
| --- | --- | --- |
| `project.root` | fail | The requested directory could not be inspected as a real directory. Pass the intended accessible directory with `--project`. |
| `project.scope` | info / skip | States whether paths came from the Git index or a directory scan. An unavailable trusted Git executable is recorded as skipped Git coverage. |
| `project.incomplete` | warn | Time/count/byte limits, inaccessible paths, unexpected Git errors, or unsafe metadata reduced coverage. Inspect a smaller directory or resolve the specific problem. |
| `project.windows-names` | warn / pass / info | Checks reserved device names/characters and trailing spaces/periods in path components. Rename incompatible components if Windows support is required. |
| `project.case-collisions` | warn / pass / info | Compares file names and directory prefixes without case. Choose distinct names and update references; changing `core.ignorecase` does not repair the collision. |
| `project.script-crlf` | fail / warn | CRLF appeared in a sampled Unix script header. Status is `fail` for a CRLF shebang on a Unix host; other cases warn. Save intended Unix scripts with LF and review the diff. |
| `project.script-bom` | fail / warn | A BOM precedes a sampled Unix script/shebang. Fails on Unix hosts and warns on Windows. Save the intended script as UTF-8 without a BOM. |
| `project.script-headers` | pass / info / skip | No CRLF/BOM was found in inspected Unix headers, or none were identified. File content beyond the header sample is outside the check. |
| `project.script-mode` | info | A shebang script has Git index mode `100644`. For intended direct execution, review `git update-index --chmod=+x -- path`; interpreter invocation can be intentional. |
| `project.symlinks` | info | Symlink targets or paths through symlinked parents were skipped. Check required links separately on each supported platform. |
| `project.submodules` | info | Submodule contents were excluded. Run WSLens inside a submodule when it needs its own report. |

When Git succeeds, paths and modes come from the index beneath the requested
directory; script samples come from the working tree. Untracked files are excluded,
even for an empty index. The fallback scan excludes dependency/build/cache and
private directories. Candidate headers omit private files, generated paths,
symlink targets, and submodule contents. No project script is executed.

The clean name/case/header findings become `info` when coverage is incomplete.
Case comparisons use JavaScript lowercase matching, not every filesystem's Unicode
rules. Windows can have case-sensitive directories. See [Windows names](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file),
[case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity),
[Git index scope](https://git-scm.com/docs/git-ls-files), and [Git attributes](https://git-scm.com/docs/gitattributes).

For a reviewed line-ending policy, a targeted `.gitattributes` entry such as
`*.sh text eol=lf` is often appropriate. Avoid normalizing the entire repository
solely to address one script; inspect the affected diff first.

## TCP listeners and explicit probes

| Finding ID | Status | What it establishes; useful next step |
| --- | --- | --- |
| `ports.listeners` | info / skip | Reports visible TCP listeners and best-effort PID/short process names. Choose another development port or inspect the listed application before stopping it yourself. |
| `ports.visibility` | warn / skip | Some records/tools were unavailable, malformed, limited, or permission-restricted. Empty output cannot establish that a port is unused. |
| `ports.probe` | info / warn / skip | Reports explicit IPv4/IPv6 loopback connection results. Errors/timeouts warn; refusal and an unavailable address family are informational. No port means no probe. |

Linux reads `/proc/net/tcp` and `tcp6`; Windows uses system PowerShell with a
`netstat` fallback; macOS uses `lsof` and always notes permission-limited visibility.
PID ownership is optional and may be shared. Nothing kills a process or reserves
a port. `--probe` connects only to `127.0.0.1` and `::1`, sending no application data.
A TCP handshake does not prove application health, firewall configuration, or
reachability from Windows, another distribution, a container, or the LAN. See
[Microsoft WSL networking](https://learn.microsoft.com/en-us/windows/wsl/networking).

## Default safety limits

| Inspection | Default caps |
| --- | --- |
| Whole CLI command | 20 seconds; the command deadline is an error, not a completed report. |
| Environment | 2 seconds overall; 1 second per filesystem operation; 512 KiB of mount metadata; 4,096 mounts. |
| PATH | 5 seconds overall; 1 second per filesystem operation; 256 entries; 131,072 characters. A cut-off entry is not searched. |
| Requested tools | CLI: 20 names, 128 characters each. Engine: 32 names, 255 characters each. |
| Command lookup | 5 seconds overall; 1 second per filesystem operation; 8,192 candidate lookups. |
| Windows directory matching | 8,192 entries per directory; 65,536 entries across directories. |
| PATHEXT | 32 entries and 8,192 characters; default when unset: `.COM;.EXE;.BAT;.CMD`. Explicitly empty stays empty. |
| Project paths | 5 seconds overall; 10,000 files; 20,000 records, visited entries, or distinct components; 64 directory levels. |
| Project content | 8 KiB per candidate header; 8 MiB total sampled bytes. |
| Project Git | 2 seconds per Git invocation within the project budget; 4 MiB index output; 4 KiB repository-probe output. |
| Listener inputs | 1 MiB per table or command result; 4,096 listeners per parsed source; 32,768 text rows/fields, excluding a recognized Linux header. Linux has separate IPv4/IPv6 tables. |
| Listener timing | Linux table reads: 1.5 seconds each, in parallel. Windows/macOS helper commands: 3 seconds each. |
| Linux ownership | 650 ms; current process plus up to 256 other processes; up to 4,096 descriptor checks; 160-byte short-name reads. |
| Loopback probes | 500 ms per address family; IPv4 and IPv6 run in parallel. |
| Finding examples | Usually 12 paths; listener findings show 20 observations and at most 8 visibility issues. Text listener tables show up to 100 rows. |
| Snapshot input | `diff` accepts regular JSON snapshot files up to 4 MiB each. |

These are inspection caps, not guarantees about how quickly an operating system
releases a stalled filesystem request. Timeouts report incomplete coverage; an
expired scan budget stops new inspection work. The CLI exits after output is flushed. JSON retains structured
candidates/listeners within the scan caps. See [CLI usage](cli.md) for commands
and [privacy](privacy.md) before sharing a report.
