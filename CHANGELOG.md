# Changelog

## Unreleased

- Reject unsupported or sanitized command identity aliases in imported diagnostic snapshots before diff comparisons, preventing false unchanged results from stripped control characters.

## 0.1.0 — 2026-10-10

Initial implementation of WSLens.

- Diagnose project portability, filesystem placement, PATH hygiene, and command resolution.
- Inspect current-namespace TCP listeners; probe IPv4 and IPv6 loopback explicitly.
- Translate Windows drive paths, WSL UNC paths, and Linux paths with custom mount roots.
- Export redacted text, JSON, or Markdown reports and compare JSON snapshots.
- Bound generated diagnostic JSON to the 4 MiB snapshot input limit, disclosing omitted optional candidate/listener/PATH details without discarding findings.
- Reject snapshot finding IDs and JSON field names altered by text sanitization, and reject finding IDs altered by home/project redaction, preventing imported reports from hiding changed findings.
- Mask capitalization aliases of project/home roots on confirmed Windows mounts and preserve the project masking policy for snapshot diffs.
- Run without third-party dependencies or install scripts on Node.js 22+.
- Include bounded subprocesses and filesystem inspection, platform fixtures, native integration checks, and an offline package installation test.
- Include a portable WSLens agent skill, Codex discovery metadata, and setup instructions for Windows and WSL.
