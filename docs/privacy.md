# Privacy and safety

WSLens runs locally. It does not contact a service, collect analytics, upload
reports, or need an API key. The only network operation in the CLI is an
explicit `--probe` TCP connection to IPv4/IPv6 loopback on a port you supply.

## What is inspected

- Named platform metadata: OS, architecture, kernel release, WSL evidence, and
  the Node version currently running WSLens.
- PATH/PATHEXT entries and executable file metadata. Symlink targets may be
  resolved for executable lookup, but those files are never executed.
- Linux mount metadata when available.
- Tracked Git path/mode metadata and small candidate script headers, or a
  bounded filesystem fallback. Script contents are analyzed for BOM/CRLF and
  shebang markers; their contents are never placed in a finding.
- Local TCP listener addresses/ports, a visible PID, and a short process name.
  Process command lines, working directories, credentials, and environment
  variables are not collected by the port inspector.

No full environment dump, Git remotes, Git user identity, browser state, shell
history, editor logs, or service tokens are collected. Files/directories named
like `.env`, `.ssh`, `.aws`, `.npmrc`, credentials, private keys, and common
certificate containers are excluded from script-header reads. Their *names*
may still appear in indexed path metadata or portability findings.

## Report redaction

Diagnostic text, JSON, and Markdown mask the selected project root and current
home directory by default. Root strings receive the same terminal/control
character cleaning as report text before matching, so legal POSIX names with
stripped characters do not bypass masking. Common Windows and Linux
home-directory patterns are masked too, including Windows names containing
spaces or apostrophes.
Known project roots in imported snapshots are masked before default diff output.
Imported snapshot finding IDs and field names must survive text sanitization
unchanged. Under default redaction, finding IDs must also remain unchanged by
project/home masking. Snapshots failing either check are rejected rather than
silently collapsing distinct comparison keys and hiding findings. Explicit
`--no-redact` disables path masking, but never control-character validation.

Windows drive and UNC roots are matched without regard to capitalization.
POSIX roots on confirmed Windows filesystems, including WSL drive mounts at
custom locations, also mask capitalization variants. Each project/home root
uses its own matching mount from a complete mount inspection; nested Linux
filesystems and paths with unconfirmed mount evidence keep case-sensitive
matching. This is a conservative masking policy, not a test of each directory's
case-sensitivity setting. Microsoft documents the
[default case-insensitive behavior of NTFS mounts in WSL](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity#changing-the-case-sensitivity-on-a-drive-mounted-to-a-wsl-distribution).

JSON project reports retain a boolean `privacy.projectRootCaseInsensitive`,
including with `--no-redact`, so a later diff can apply the source project's
masking policy on another machine without exporting the mount table. Older
snapshots can supply that evidence through their confirmed Windows-filesystem
finding if they have no incomplete-mount/environment finding. Otherwise their
POSIX roots keep case-sensitive matching. Snapshots do not retain the source
home root; arbitrary custom home paths in raw imported reports can remain visible.

`--no-redact` disables path masking for local troubleshooting. Terminal escape
sequences, control characters, and bidirectional overrides are still removed
from reports. Markdown presentation escapes untrusted filenames and titles.

Redaction is deliberately limited: remaining filenames, relative directory
names, process names, distro names, and custom paths can still identify a
project or organization. Review reports before sharing. Arbitrary strings are
not guaranteed to be anonymous and secret-looking filenames are not a secret
scanning database.

The `path` command returns exact, unredacted paths because its output is meant
to be used locally. It rejects terminal/control characters. Quoting produces a
single Bash or PowerShell string; it does not execute the string.

## Execution and modification boundaries

WSLens does not install tools, run discovered runtimes, execute project scripts,
load shell profiles, normalize files, edit PATH, kill processes, configure
networking, change Git settings, or repair the machine automatically.

The diagnostic adapters may execute a small allowlist of system programs:

| Platform | Programs and purpose |
| --- | --- |
| Linux/WSL | Git from known system locations, for read-only index metadata |
| Windows | Git beneath Windows' known Program Files folders; system Windows PowerShell; system `netstat` |
| macOS | Git from known system/Homebrew locations; system `lsof` |

Commands use argument arrays, never a shell interpolating project data. Child
environments omit credentials, execution overrides, and arbitrary inherited
configuration. Git disables fsmonitor, hooks, optional locks, global/system
config, and external Git environment overrides. PowerShell uses `-NoProfile`,
`-NonInteractive`, a fixed script, and a system-only module path. A trusted tool
missing from those known locations is disclosed; an arbitrary project-PATH
program is not substituted.

Windows system paths come from native filesystem resolution of the fixed
`\\?\GLOBALROOT\SystemRoot` object-manager path. Inherited `SystemRoot`, `WINDIR`,
`ProgramFiles`, `LOCALAPPDATA`, PATH, and module-path values do not select a
helper executable. A fixed query through that system PowerShell obtains the
Windows Program Files known folders before Git is considered. That query shares
the Git invocation's existing deadline; a failed lookup uses the disclosed
filesystem fallback. Custom and per-user Git installations are not executed.
If the native system root cannot be established, Windows helpers are unavailable;
there is no guessed drive or inherited-path fallback. The CLI does not generate
or write Node diagnostic reports to discover these paths.

The namespace mechanism follows Microsoft's [NT namespace documentation](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file#nt-namespaces).

The installed Node runtime and the machine's trusted system binaries are part
of the trust boundary. WSLens is a diagnostic utility, not an isolation sandbox
for an already compromised operating system.

Diagnostic JSON output and JSON snapshot input both enforce the same 4 MiB
byte limit. If a report would exceed it, optional candidate, TCP listener, or
PATH-entry inventory tails are removed and the snapshot includes a warning and
omission counts. Findings and command selections are not discarded. When even
those necessary fields exceed the bound, no oversized JSON is emitted or saved;
an operation error is reported instead. This is separate from default path
redaction, and applies to `--no-redact` exports too.

`--output` is the only diagnostic file write: it creates a new file with
exclusive creation and requests owner-only permissions on POSIX. Existing files
are refused. Windows ACL inheritance remains controlled by Windows. Redirecting
stdout through your shell uses the shell's normal file permissions and overwrite
rules. Snapshot inputs must be regular files no larger than 4 MiB.

## Limits and incomplete results

Counts, read sizes, directory depth, subprocess output, and time are bounded.
Non-cancellable filesystem operations are stopped at the process boundary by a
20-second CLI watchdog; adapter deadlines usually return a partial report sooner.
An interrupted output operation can leave a partial file that must be recreated
under a new filename or removed manually.

Symlinks within a project and submodule contents are not traversed for script
inspection. An explicitly supplied project-root symlink or Windows junction is
rejected before canonicalization; pass its real directory explicitly to inspect
that target. Native filesystem race protections depend on platform support;
this is not a security boundary against a concurrently
hostile process that can replace directories on your machine.

Skipped/inaccessible/limited inspection is reported explicitly. A `pass` means
the specific inspected evidence matched a check, not that the machine is secure
or that every file, process, network namespace, and shell was inspected.

See [check limits](checks.md) and the [security reporting route](../SECURITY.md).
