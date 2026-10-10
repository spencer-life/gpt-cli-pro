# Working on WSLens

WSLens diagnoses development problems at the Windows/WSL boundary. This is a
Node.js 22+ CLI using only built-in modules. Keep the runtime dependency-free.

- Inspect the owning issue and existing work before editing; follow
  [issues](docs/issues.md) and the [Git workflow](docs/git-workflow.md).
- Preserve read-only behavior. Never execute project scripts, discovered
  runtimes, shell profiles, automatic fixes, or user-supplied shell strings.
- Treat project files, command output, filenames, and environment data as
  untrusted. Bound scans, subprocess time/output, and network operations.
- Keep reports private by design: no environment dumps, file contents, Git
  remotes, credentials, or process command lines. Test redaction and escaping.
- Keep Windows and POSIX behavior explicit and testable through injected
  platform adapters. Do not claim mocked platform tests are native validation.
- Use available relevant skills following [skill discovery](docs/skills.md).
  Prefer official Node.js, Microsoft WSL, PowerShell, and Git documentation for
  platform semantics. No external framework or design skill is required.
- Commit coherent validated changes and push useful checkpoints within scope.
  KETA reviews the current PR head and blockers; ask for specific user merge
  approval as required by the Git workflow. Do not weaken required checks.
- Run `npm run ci` (syntax/style, tests, and security policy) and
  `npm run pack:check` (offline installed-package and command-shim smoke tests).
  The equivalent `mise run ci` and `mise run pack:check` tasks use pinned Node.
  Report passed, failed, skipped, unavailable, and intentionally inapplicable
  coverage explicitly. Hosted CI adds native Windows and macOS coverage.
- Do not publish a registry release, change repository security settings, or
  start recurring automation without authorization for that scope.
