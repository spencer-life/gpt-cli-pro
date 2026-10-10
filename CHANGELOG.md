# Changelog

## 0.1.0 — 2026-10-10

Initial implementation of WSLens.

- Diagnose project portability, filesystem placement, PATH hygiene, and command resolution.
- Inspect current-namespace TCP listeners; probe IPv4 and IPv6 loopback explicitly.
- Translate Windows drive paths, WSL UNC paths, and Linux paths with custom mount roots.
- Export redacted text, JSON, or Markdown reports and compare JSON snapshots.
- Run without third-party dependencies or install scripts on Node.js 22+.
- Include bounded subprocesses and filesystem inspection, platform fixtures, native integration checks, and an offline package installation test.
