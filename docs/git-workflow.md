# Git workflow and ongoing maintenance

Use this flow for each task: issue or tracked work item, focused branch or stack,
coherent commits, relevant checks, confirmed delivery, then cleanup and tracker
completion. Carry unfinished work and blocked validation in the handoff.
Repository instructions apply even when personal skills are absent.

## Standing delivery policy

For requested repository work, automatically track issues, commit coherent
validated progress, push useful checkpoints, and create/update PRs within scope.
Merge only after KETA review and specific user approval; then clean up completed
task branches.
For local-only projects, deliver to local `main` without adding a remote.
Scoped repository rules and explicit user directions take precedence.

Apart from specific merge approval, ask only for an unresolved material decision:
significant live-service effects,
destructive operations risking undelivered work, irreversible changes, new
release/deployment scope, or changes
to access or safeguards. Known authorized deployment effects need no repeat
approval. Credentials do not establish authority. Never bypass required checks,
reviews, protection, tool approvals, or credential boundaries.

Commit at coherent recovery points; batch pushes at meaningful progress, handoff,
and delivery points to avoid unnecessary CI. Publish issue/PR status and enough
branch, commit, validation, and next-step context for another environment to
resume. Ignored local state is not a remote handoff.

## Branches and stacked PRs

For new independent work, start from current `main` in a clean task checkout.
Resume existing work on its owning branch. Preserve unrelated edits and inspect
existing branches/worktrees before creating another. Use a short topic
name such as `fix/login` or `feature/export`; include the issue number when useful.
One focused change normally needs one branch and PR. Use a linear stack when
separately reviewable changes depend on each other; use separate branches/stacks
for independent work. Plan layers before implementation, foundation first.

Native stacks use the optional `github/gh-stack` GitHub CLI extension, tested with
`v0.1.1`. It is separate from a personal skill and from the base mise setup.
If missing, installing it is an environment setup decision:
`gh extension install github/gh-stack`. Check installed help before unfamiliar
commands; native stacked PRs are a preview and may be unavailable for a repository.
Use an ordinary PR or explicit handoff if unavailable; report the limitation.

```sh
gh stack init feature/foundation
# Implement, validate, and commit the foundation.
gh stack add feature/integration
# Implement, validate, and commit the next concern.
gh stack submit --auto --remote origin
gh stack view --json
```

`submit --auto` publishes branches and creates draft PRs; add `--open` when ready
for review within authority. Edit generated titles and bodies to describe each
layer and link its issue. Upper PRs target the branch below; other PRs target
`main`. Use explicit targets and noninteractive flags, never a bare interactive
stack command in an agent session. With multiple remotes, select the intended
remote explicitly; commands without a remote flag need repository-local
`remote.pushDefault` configured deliberately.

Edit the branch owning a concern, commit there, then rebase dependent layers with
`gh stack rebase --upstack --remote origin`. For offline/local-only stacks use
`gh stack rebase --upstack --no-trunk`, which does not refresh remote trunk.
`submit`, `push`, and `sync` write remote state; `sync` also rebases and pushes.
Inspect its resulting state: a message such as `Sync aborted` can accompany a
successful exit code. Local-only projects can use branch creation and local
rebase without publishing; see [local setup](local-projects.md).

If an environment has only a GitHub connector, track issues and PRs through it.
Use ordinary single PRs where suitable. For a native stack, use the extension in
an environment with terminal access or hand off its exact branch/PR state; do not
simulate missing CLI operations or assume a personal skill is installed.

## Delivery and cleanup

Before delivery, verify checks on the latest heads, resolved conversations, the
intended diff and base, applicable reviews/rules, and deployment consequences.
Follow required checks through completion, fix failures caused by this change,
and verify the actual merge. An auto-merge request or watcher handoff alone is
not completion. Use bounded monitoring; report concrete blockers rather than
retrying unchanged failures. If another task owns fixes/merge, observe its outcome
without starting a competing writer. For stacks check all
layers in the proposed merge. Native stack merges use
`gh stack merge <target> --yes --squash` within authorization; the target includes
all unmerged layers below it, and a stack number includes the entire stack.
Do not substitute an ordinary `gh pr merge` for a registered native stack.

After confirmed delivery:

1. Confirm the actual merged PRs or delivered local commits and acceptance
   criteria. Record validation and delivery in the issue/work item; close it only
   when the whole task is delivered.
2. Fetch and prune obsolete remote-tracking refs when online. Refresh local
   `main` safely; do not reset a dirty checkout or overwrite local work.
3. Remove only completed task branches that have no undelivered changes, dirty
   work, active worktree, or remaining stack dependency. Squash merges require
   checking GitHub's merged state and the delivered diff; commit ancestry alone
   cannot prove delivery. Use `gh stack sync --prune --remote origin` only after
   reviewing its rebase, push, and deletion scope within authorization.
4. Keep unfinished branches/worktrees and report their purpose and next step.
   Age alone is not grounds for deletion. Do not bulk-delete branches or stash
   unrelated work to make cleanup succeed.

Local-only projects deliver validated branches to local `main`, then apply the
same cleanup checks. Preserve a recovery path before destructive Git operations.

## Keep repositories healthy

Use the [dependency freshness policy](dependency-freshness.md) for bootstrap and
maintenance: reproducibility, compatible updates, expiring holds, and prompt
security review.

Review open issues, PRs, active stacks, branches/worktrees, and dependency status
periodically and when returning to a project. Resolve obsolete work deliberately;
record blocked or deferred work rather than leaving its purpose unexplained.
At task completion, report anything still open and why.

For hosted projects, verify Renovate app access and a healthy Dependency Dashboard
or recent bot runs. Review its scheduled updates, vulnerability findings, tool
pins, manifests, and lockfiles. Automerge starts disabled. Use one dependency
update bot; do not duplicate Renovate with Dependabot version-update PRs. The
GitHub CLI extension is installed separately, so review its version as part of
environment maintenance too.

For local projects, use `mise outdated` and the chosen stack's native audit/update
tools. Group compatible updates into focused changes, review migration notes,
update lockfiles with their package manager, and run affected checks before
committing. Tool versions are pinned for reproducibility, so upgrades are
intentional; a template cannot keep abandoned repositories updated by itself.
Delivery authority covers preparation of the requested work; merging requires
specific user approval. Unrelated branch sweeps, releases and background
automation need their own scope.

References: [native stack extension](https://github.com/github/gh-stack),
[GitHub stacked PRs](https://docs.github.com/en/pull-requests/get-started/about-stacked-prs),
[stacked PR behavior](https://docs.github.com/en/pull-requests/reference/stacked-pull-requests),
and [workflow triggers](https://docs.github.com/en/actions/how-tos/write-workflows/choose-when-workflows-run/trigger-a-workflow).

## KETA merge approval

KETA reviews evidence for the current full PR head SHA, the intended diff/base,
required core/security/specialist coverage, unresolved findings, conversations,
reviews and effective protection. KETA reports remaining blockers and asks the
user for specific merge approval identifying the repository, PR, head SHA and
any stack layers. Routine automatic merging is not authorized by a green check,
a Muse report or this guidance. Recheck the head and blockers before executing
an approved merge; a changed head needs renewed review and approval.
