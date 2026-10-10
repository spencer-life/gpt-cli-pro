# Security

## Supported version

Security fixes are developed on the current implementation/main branch for the
0.1 series. WSLens does not update itself or contact a release service.

## Report a vulnerability

Use GitHub's **Report a vulnerability** action in this repository's Security tab
if it is available. Availability of private reporting has not been assumed or
enabled by this change. If that action is unavailable, open an issue asking for
a private contact route **without including exploit details, credentials, or a
real diagnostic report**. Do not post sensitive findings publicly.

Provide the WSLens version, affected platform, a minimal synthetic reproduction,
and the impact. Include no real usernames, project secrets, or tokens.

## Security model

See [Privacy and safety](docs/privacy.md) for the inspected data, execution
allowlist, redaction scope, file writes, and platform limits. Runtime code has no
third-party dependencies and no install/prepare hooks. Finding a clean report
does not mean a machine is free of security vulnerabilities.

The security task checks targeted policy and credential patterns. It does not
replace code review, platform testing, operating-system patching, or dedicated
security tooling.
