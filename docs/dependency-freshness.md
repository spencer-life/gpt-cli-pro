# Fresh enough, deliberately

Reproducible installs and current dependencies answer different questions.
Pinned tools and committed lockfiles reproduce the chosen inputs. `mise install`,
`npm ci`, and other frozen installs do not establish that those inputs are fresh.
An official scaffold tagged `latest` can select older vendor-tested packages.

Before the first development commit, after mechanical initialization and the
chosen scaffold, query live registries/tool sources and record the check time,
selected versions, supported constraints, newest eligible releases, and available
major upgrades. Use the project's validated freshness task or native inventory
and audit tools. Review compatible updates, regenerate the existing lockfile with
its owner, and run the actual project checks. Record unavailable/unsupported
coverage explicitly; cached installs and passing CI are not freshness evidence.

For hosted repositories using Renovate, keep compatible updates moving through
the existing maintenance flow. Verify bot access and recent Dashboard/run
activity at setup and when returning to a project; periodically review unresolved
updates and tool pins. For local-only projects, run the validated freshness task
or native inventory and audit commands at setup, when returning to development,
and after material stack changes; review and apply compatible updates manually.
Local-only projects do not need a hosted bot or background automation. Release-age
cooldowns reduce immediate exposure to new releases; they do not detect stale
pins, prove compatibility, or guarantee a merge. Maintain reproducibility while
reviewing updates intentionally. Major upgrades require manual migration review.

A vendor/SDK-supported older version can be intentional. Record its constraint or
hold with the selected version, reason, accountable owner, and future review date.
Recheck on expiry, vendor changes, or a material stack/runtime change. An expired
or unexplained hold requires review. Do not blindly replace pins with `latest` or
assume equal release numbers mean coupled packages are compatible.

Review security findings promptly in a separate lane. Ordinary cooldowns and
compatibility holds must not hide or delay the security decision. A fix still
needs relevant checks and migration review; availability, severity, exposure,
and accepted risk determine urgency. Audit coverage is limited to supported
sources/ecosystems, so report manual tool/vendor advisory review and unknown
coverage separately. No freshness policy grants automerge, deployment, new app
permissions, or repository-security-settings authority.

References: [mise upgrade](https://mise.jdx.dev/cli/upgrade.html),
[mise locks](https://mise.jdx.dev/dev-tools/mise-lock.html),
[npm frozen installation](https://docs.npmjs.com/cli/v11/commands/npm-ci/),
[Renovate release age](https://docs.renovatebot.com/key-concepts/minimum-release-age/),
and [Expo SDK compatibility](https://docs.expo.dev/workflow/upgrading-expo-sdk-walkthrough/).
