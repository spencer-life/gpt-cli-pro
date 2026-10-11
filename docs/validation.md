# Validation and remaining coverage

This document describes the checks for the initial WSLens implementation on
2026-10-10. The implementation PR records the tested full commit SHA, command
results, and hosted check links. A configured workflow does not establish that
its jobs passed; inspect the checks attached to the current PR head.

## Reproduce the checks

From a clean checkout with Node.js 22 or newer:

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm run pack:check
npm run demo
```

`npm run ci` runs syntax and formatting checks, Node's test runner, and the
focused security policy checker. The package has no third-party dependencies.
There are no dependency-install lifecycle scripts.

`npm run pack:check` creates the actual distributable tarball, installs it
offline into a temporary prefix containing spaces, verifies the package
allowlist, license, and local links in the shipped documentation, executes its
installed CLI, and invokes the installed command shim. It also verifies that
all three WSLens skill files are packaged and installed byte-for-byte. On Windows that final
check invokes the generated `.cmd` through
the system PowerShell. All temporary package files are removed afterward.

`npm run demo` makes a disposable project with deliberate portability defects,
shows the real diagnostic output, checks the expected result, and cleans up.

## Platform evidence

| Coverage | Where it is checked |
| --- | --- |
| Linux command integration, filesystem inspection, reports, and package installation | Local Linux executor and hosted Ubuntu jobs |
| Real Linux TCP listener, owning PID, and explicit loopback probes | Linux native integration test using `/proc` |
| Windows PATH/PATHEXT, PowerShell script candidates, mounts, and filename behavior | Injected platform fixtures on every OS |
| Actual Windows PowerShell TCP collection and probe | Native Windows integration test in hosted Windows jobs |
| PowerShell literal evaluation for ASCII and typographic apostrophes | Native Windows test, skipped on other platforms |
| Installed Windows `.cmd` with a prefix containing spaces | Hosted Windows package check |
| Native Windows system-root discovery and helper selection with poisoned environment paths | Windows integration tests; malformed/unavailable roots and helper bounds also have injected coverage |
| Actual macOS `lsof` collection, owning PID, and probe | Native macOS integration test in hosted macOS jobs |
| WSL1/WSL2 detection, drvfs and custom mounts, nested mount boundaries, and Windows/Linux command mixing | Injected fixtures; no native WSL distribution was available in the local executor |

The native port tests create a real ephemeral listener. They require the exact
bound address, port, family, and current process owner, and verify that passive
inspection makes no connection. The explicit IPv4 probe must create one
connection. Windows requires the PowerShell collector when system PowerShell
exists; a broken query cannot silently pass through the `netstat` fallback.

Fixture coverage does not establish behavior on every Windows build, WSL
distribution, filesystem driver, permission configuration, or localized OS.
Real Windows-to-WSL forwarding, firewall behavior, and WSL mirrored networking
are outside this tool's current-namespace port inspection and remain outside
this test claim.

## Runtime and workflow pins

The initial pins were checked against upstream on 2026-10-10:

- Node 22.23.3 and 24.21.0 on Ubuntu, Windows, and macOS.
- Node 26.11.1 on Ubuntu for current-runtime compatibility.
- Node 24.21.0 in `mise.toml`; direct npm commands are equivalent when mise is
  unavailable. The local executor initially supplied Node 24.19.0, with Node
  22 and the pinned Node 24 also run explicitly for compatibility checks.
- GitHub Actions use full commit SHAs, read-only repository permissions, and
  checkout credentials are not persisted.

References: [Node releases](https://nodejs.org/en/about/previous-releases),
[checkout](https://github.com/actions/checkout), and
[setup-node](https://github.com/actions/setup-node).

Renovate configuration is included with automerge disabled. App installation,
repository access, and successful bot runs were not established by creating
that configuration. No registry release or background maintenance service is
created by the implementation.

## Agent skill validation

The repository skill was initialized and structurally validated with the
current official OpenAI Codex-bundled creator recorded in
[creator provenance](agent-skill.md#creator-provenance-and-maintenance).
The interface metadata was parsed separately to verify its display name,
description length, `$wslens` prompt, and default implicit invocation policy.
The upstream validator does not validate that interface or prove agent behavior.

Independent agents received the skill, a realistic request, and isolated local
artifacts without the intended answer. A project edited with CRLF script
headers exercised real CLI diagnosis, nonzero finding exits, report creation,
and preservation of project files. A pair of WSL PATH snapshots exercised
before/after interpretation when an earlier candidate was inaccessible.
The PR records observed outcomes and any refinement made from those runs.

These behavioral runs used agents reading the skill as manual guidance. They
do not establish native Codex UI discovery, automatic selection, or access to
a user's Windows/WSL machine. Repository placement follows the current official
discovery documentation. Package checks verify portable file delivery on each
hosted platform; actual WSL remains the separate coverage limit above.

## Security evidence and limits

Tests exercise redaction (including roots containing stripped control characters),
rejection of imported finding identifiers and field names changed by cleaning
or default project/home redaction (to prevent snapshot diff collisions),
rejection of imported command identities altered by text cleaning (including
a real diff case that formerly returned exit 0 and a `--no-redact` check),
async/backpressured stderr completion and exit codes, terminal and Markdown
escaping, PowerShell quoting,
argument rejection, snapshot size/type checks, non-execution of project
programs, sensitive-file exclusions, subprocess output/deadline bounds,
incomplete filesystem scans, inherited Windows helper-path overrides, and
read-only report behavior. Independent code
review covered command execution, path conversion, reporting, and collection
logic; concrete findings received regression coverage before delivery.

A synthetic 20-command / 256-PATH-entry fixture produces more than 4 MiB of
raw candidate JSON. Regression tests confirm that the bounded serializer emits
valid JSON within the snapshot input limit, discloses omitted candidate counts,
keeps original findings and selected paths, preserves strict warning semantics,
and can capture two large snapshots for a real `wslens diff` invocation. Large
listener inventories and oversized non-optional finding evidence are tested
separately. Cross-platform CI runs the same fixtures without requiring thousands
of actual filesystem entries.

Redaction regressions reproduce capitalization aliases under standard WSL and
custom Windows mounts in text, JSON, and Markdown. They check independent
project/home policies, component boundaries, nested Linux and unconfirmed mount
contexts, raw-export preservation, and snapshot diffs using the source project's
masking policy. Mount behavior in these tests uses injected metadata, not a
native WSL installation.

`npm run security` checks a small, documented set of credential patterns and
process/network/workflow policies. It is not a third-party vulnerability scan,
penetration test, or proof of general security. Native platform checks and
manual review remain separate evidence. See [privacy](privacy.md) for exact
data handling and resource bounds.
