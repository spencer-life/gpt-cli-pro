# Product scope and supporting research

Research reviewed on 2026-10-10. These sources establish the relevant platform
behaviors; they do not establish adoption numbers or guarantee that a reported
condition caused a particular failure.

## Why this tool

WSLens concentrates on the boundary between a developer's project, executable
search path, Windows tools, and a WSL environment. Its purpose is to turn a small
set of observable conditions into practical explanations. It does not manage
WSL distributions or promise automatic system repair.

Microsoft recommends keeping project files on the same operating system as the
development tools that use them. Cross-filesystem access is supported but can
reduce performance. That supports a contextual filesystem-placement finding,
not a claim that every Windows-backed project is broken.

- [Set up a WSL development environment](https://learn.microsoft.com/en-us/windows/wsl/setup/environment)
- [Working across file systems](https://learn.microsoft.com/en-us/windows/wsl/filesystems)
- [Install Node.js on WSL](https://learn.microsoft.com/en-us/windows/dev-environment/javascript/nodejs-on-wsl)

WSL normally appends Windows PATH entries and supports launching Windows
processes. The automount location is configurable. A Windows executable found
inside WSL can be intentional; a path beginning with `/mnt/` does not by itself
identify a Windows drive. Findings should identify the selected executable and
the evidence for a boundary crossing.

- [WSL configuration: interop and automount](https://learn.microsoft.com/en-us/windows/wsl/wsl-config)
- [Microsoft WSL issue 3787: npm PATH confusion](https://github.com/microsoft/WSL/issues/3787)

The issue is historical evidence of a failure pattern, not proof of a current
WSL defect or its prevalence. Current documented behavior supplies the basis
for the checks.

## Project portability checks

| Observed condition | Product decision | Primary reference |
| --- | --- | --- |
| Windows-reserved characters, device names, or trailing spaces/periods | Report a portability warning. Include directory components and device names followed by extensions, including superscript COM/LPT digits. | [Microsoft file naming rules](https://learn.microsoft.com/en-us/windows/win32/fileio/naming-a-file) |
| Paths that differ only by letter case | Compare both file names and directory prefixes. Explain the usual Windows behavior without assuming every Windows directory is case-insensitive. | [Microsoft WSL case sensitivity](https://learn.microsoft.com/en-us/windows/wsl/case-sensitivity) |
| CRLF in Unix script headers or a BOM before a Unix script | Report the affected paths and targeted LF/encoding guidance. Ordinary CRLF text, Windows scripts, and binary samples do not receive a blanket error. | [Git attributes and line endings](https://git-scm.com/docs/gitattributes) |
| Shebang script stored with index mode 100644 | Give advice about direct execution; invoking the script through an interpreter can be intentional. | [Git index modes and output](https://git-scm.com/docs/git-ls-files), [Git executable permission flag](https://git-scm.com/docs/git-update-index) |
| Symlink or Git submodule | Report that the target or submodule contents were not inspected. Do not follow them as part of the project scan. | [Git symlink configuration](https://git-scm.com/docs/git-config#Documentation/git-config.txt-coresymlinks), [Git index modes](https://git-scm.com/docs/git-ls-files) |

Git's `ls-files --stage -z` supplies index paths and file modes without executing
project scripts. NUL delimiters preserve filenames containing tabs or newlines.
When Git metadata is available, the inspected set is the index beneath the
requested directory. Untracked files remain outside that scope, including when
the index is empty. When a trusted Git executable is absent, or the directory is
not a work tree, WSLens uses a bounded directory scan and states that difference.
An unexpected Git error or inaccessible path is reported as incomplete coverage.

The scanner inspects only candidate script headers. Default limits are 10,000
files, 20,000 directory entries or distinct path components, 64 directory levels,
8 KiB per header, 8 MiB of total header reads, 4 MiB of Git output, and a five-second
inspection budget. Hitting a limit prevents a clean-pass claim. Sensitive path
names, dependency/build/cache directories, symlinks, and submodules have explicit
skip behavior. File bodies and private file contents are never included in a
finding. Filesystem checks use Node's built-in APIs, check path components for
symlinks, and verify opened file identity before reading the header.

- [Node.js 22 filesystem APIs](https://nodejs.org/docs/latest-v22.x/api/fs.html)

The filesystem can change while being inspected. This is a diagnostic scanner,
not a sandbox for hostile concurrent filesystem mutation. Repositories with
unusual names, case behavior, or permissions still require validation with their
actual tools and platforms. Case comparisons use JavaScript lowercase matching;
they are not an emulation of every filesystem's Unicode case tables.

## Networking boundaries

WSL's NAT and mirrored network modes have different Windows/guest localhost
behavior. A local listener or successful connection within one network namespace
does not prove reachability from the Windows host, another distribution, a
container, or the LAN. WSLens port results must keep that scope explicit.

- [Microsoft: Accessing network applications with WSL](https://learn.microsoft.com/en-us/windows/wsl/networking)

## Existing tools and overlap

| Tool | Documented scope | Relationship to WSLens |
| --- | --- | --- |
| [wslkit](https://wslkit.github.io/wslkit/) | WSL diagnosis, virtual disk maintenance, resource limits, proxies, and Windows/guest bridges in a Go binary. | WSLens focuses on project and executable-resolution evidence. It is not the first WSL doctor. |
| [envinfo](https://github.com/tabrindle/envinfo) | Environment and tool-version reports for troubleshooting. | WSLens adds narrowly defined findings and remedies without running discovered runtimes. |
| [mise doctor](https://mise.jdx.dev/cli/doctor.html) | Mise setup checks and project-declared diagnostics; its [PATH command](https://mise.jdx.dev/cli/doctor/path.html) reports mise's PATH composition. | WSLens runs independently of a version manager or project configuration. |
| [Codex Windows Doctor](https://github.com/Yaro-Tab/codex-windows-doctor) | A Codex-specific Windows/WSL diagnostic skill and collector. | WSLens is independent of an editor or coding assistant and does not inspect assistant state or credentials. |

Node.js 22+ was chosen for portable installation without a compilation step and
for implementation using built-in modules. This is a runtime requirement, not a
standalone-binary claim. WSLens has no third-party runtime package dependencies;
it does not install or repair Node itself.

## Validation interpretation

Tests cover real temporary Git repositories and filesystem fixtures, plus
injected metadata for platform-specific cases. Cross-platform fixtures support
deterministic checks for Windows names, modes, and output formats. They do not
substitute for executing the tool on native Windows or WSL. Delivery reports
should state which environments were actually available.
