# Contributing to WSLens

Use an issue to describe the developer problem, expected behavior, and affected
platforms. Keep a change focused. Read [AGENTS.md](AGENTS.md), the
[issue workflow](docs/issues.md), and [Git workflow](docs/git-workflow.md).

## Set up and validate

Use Node.js 22+ (mise pins the development runtime to 24.21.0):

```sh
npm ci --ignore-scripts --no-audit --no-fund
npm run ci
npm run pack:check
```

The same checks are available through `mise run setup`, `mise run ci`,
`mise run security`, and `mise run pack:check`. Mise is optional if a compatible
Node/npm runtime is already available. There are no third-party dependencies.

`npm run lint` checks JavaScript syntax and source hygiene. `npm test` runs
parser, filesystem, subprocess, CLI, and native integration tests. `npm run
security` is a focused policy/credential-pattern scan, not a complete security
audit. `pack:check` packs the allowlisted distribution, installs it offline into
a temporary prefix with spaces, and executes the installed CLI and platform shim.

Preserve exact-head validation evidence. State which platform/runtime actually
ran each check, including skipped or unavailable native Windows, macOS, and WSL
coverage. A Windows fixture on Linux is not native Windows validation.

## Change boundaries

- Keep diagnosis local and read-only; no automatic fixes or discovered-tool execution.
- Use stable finding IDs and accurate `pass/info/warn/fail/skip` meanings.
- Test the failure being fixed with real data shapes and relevant native I/O.
- Preserve count/byte/time bounds and disclose incomplete results.
- Treat filenames, PATH entries, command output, and snapshot contents as untrusted.
- Keep source code dependency-free unless a deliberate architecture change is reviewed.
- Never put credentials, real personal diagnostic reports, dependencies, or build output in commits.

## Pull requests and releases

Branch from current `main`, reference the issue, and explain the concrete problem,
resulting behavior, and relevant validation. CI runs on pull requests using
read-only tokens and commit-pinned actions. No release or deployment is triggered.
KETA review and specific user merge approval follow `docs/git-workflow.md`.

Registry publication is separate from merging. A future release should recheck
native tests, version agreement, package contents, license, and install behavior,
then obtain authorization for publication. Do not imply a package exists on npm
until publication has been observed.
