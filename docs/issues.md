# Issues as shared project state

Use or reuse an issue for repository work, including setup and maintenance.
Search existing issues first; keep small related corrections on the current
issue rather than creating duplicates. Record the problem, acceptance criteria,
status, validation, and delivery link. Personal skills are optional: these
instructions apply with GitHub CLI, an API/connector, or plain Markdown.

## Hosted projects

GitHub Issues are the shared source of status. Use available GitHub tools to
search, create, and update them within authorization. Link the issue in each PR.
For a stack, use `Refs #42` on intermediate layers and `Closes #42` only on the
final delivery PR. Keep the issue open while required layers remain undelivered.
Confirm the merged result and acceptance criteria before marking work complete;
a local commit or open PR is not delivery.

When terminal tools are available, optional `gh-issue-sync` provides an ignored
Markdown mirror. Verify the new repository's origin and authenticate `gh` through
the environment's approved method before initializing it. The tasks pin version
`0.3.0` through mise without installing it during ordinary setup or CI:

```sh
mise run issues:init
mise run issues:pull
mise run issues:status
mise run issues:new -- "Describe the work"
mise run issues:plan
```

The new issue is a local draft with a `T`-prefixed ID. Edit its Markdown body, then
preview a scoped push, for example `gh-issue-sync push --dry-run T123abc`, before
the authorized `gh-issue-sync push T123abc`. These direct commands require the
CLI on PATH; use the mise-pinned tool environment when necessary:
`mise exec github:mitsuhiko/gh-issue-sync@0.3.0 -- gh-issue-sync push --dry-run 42`.
After publication the filename uses the real issue number. Scope later pushes to
that number. Remote creation, updates, comments, and closure follow the same
authorization as direct GitHub operations.

`gh-issue-sync sync` **pushes before it pulls**; do not use it as a read-only
refresh. Pull can encounter conflicts; inspect them rather than force-overwriting
local drafts. Verify actual GitHub state after publication or closure. For
confirmed delivery, close with available GitHub tools, or the installed CLI's
`gh-issue-sync close 42 --reason completed`.

Ignored `.issues/` drafts do not travel with a clone or Cloud task. Publish
updates within authority or preserve pending text in a tracked work item and
handoff. If a connector can manage GitHub issues, use it directly; lacking the
sync skill does not prevent issue tracking.

## Local-only projects and unavailable GitHub access

Create `docs/work/0001-short-title.md` using [the work-item guide](work/README.md).
Choose the next unused number. These versioned files are the tracker when the
project has no GitHub remote; they also preserve unpublished hosted work when
GitHub access is unavailable. Link the file in commit/branch handoffs.

For local-only projects, mark work complete after the validated change reaches
local `main`, recording the delivered commit. For hosted work awaiting delivery,
keep it open until its PR has merged. When access becomes available, publish the
issue within authority and record its link. GitHub then becomes the shared status
source; avoid maintaining two independently edited trackers.

Keep secrets out of issues, work items, and comments. Use the reporting route in
`SECURITY.md` for sensitive vulnerabilities.
