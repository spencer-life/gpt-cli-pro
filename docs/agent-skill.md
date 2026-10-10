# Use WSLens with an agent

The WSLens skill gives a coding agent a practical guide to the CLI: select an
inspection, interpret evidence and incomplete checks, and explain a focused
next step. It is useful when you want to describe a development problem in
ordinary language instead of choosing flags yourself.

The tool is JavaScript running on Node.js 22+. The skill is Markdown
instructions plus YAML interface metadata; it needs no AI API key, MCP server,
Python runtime, or extra package to use. Your chosen agent supplies its own
model and shell access. The CLI itself makes no AI requests.

## Use in this checkout

The entrypoint is [SKILL.md](../.agents/skills/wslens/SKILL.md), with a portable
[command reference](../.agents/skills/wslens/references/commands.md) and
[Codex metadata](../.agents/skills/wslens/agents/openai.yaml).

Open Codex in a checkout containing these files. Codex discovers
`.agents/skills` from the working directory through the repository root. You
can select the skill with `/skills`, mention `$wslens`, or let Codex select it
when the request matches. Automatic selection remains enabled. If the new
skill does not appear, restart Codex. These locations and invocation rules
follow [OpenAI's current skill documentation](https://learn.chatgpt.com/docs/build-skills#where-codex-loads-local-skills).

```text
Use $wslens to diagnose this project's Windows/WSL setup.
Explain the most useful finding and the next step.
```

```text
Use $wslens to explain which Node and npm installations this environment finds.
```

```text
Use $wslens to compare before.json and after.json. Did the findings improve,
and were any checks unavailable?
```

Node must be available. An agent working in this checkout can run
`node bin/wslens.mjs`; when diagnosing a different project, it can use the
absolute CLI path while keeping that project's working directory. An installed
`wslens` command is another option. See the [README](../README.md#start-here)
for installation and the initial review build.

## Use across your projects

Copy the complete `wslens` skill folder into `~/.agents/skills` for the user
and environment where Codex runs. The skill's relative reference stays inside
that folder, so it works after copying. Choose a personal copy when you want
the skill available across repositories, or copy it into another repository's
`.agents/skills` for that project only. Avoid keeping duplicate copies with the
same name in one Codex context.

From the WSLens checkout, these optional commands create a personal copy and
stop short of replacing an existing skill.

### WSL, Linux, or macOS shell

```sh
wslens_skills_dir="$HOME/.agents/skills"
if [ -e "$wslens_skills_dir/wslens" ] || [ -L "$wslens_skills_dir/wslens" ]; then
  printf '%s\n' 'A wslens skill already exists; review it before replacing.' >&2
else
  mkdir -p "$wslens_skills_dir"
  cp -R .agents/skills/wslens "$wslens_skills_dir/wslens"
fi
```

### Windows PowerShell

```powershell
$wslensSkillTarget = Join-Path $HOME '.agents/skills/wslens'
if (Test-Path -LiteralPath $wslensSkillTarget) {
    throw 'A wslens skill already exists; review it before replacing.'
}
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $wslensSkillTarget) | Out-Null
Copy-Item -LiteralPath '.agents/skills/wslens' -Destination $wslensSkillTarget -Recurse
```

The copy installs instructions only. Keep a trusted WSLens CLI installation or
checkout available too. If you installed the CLI globally, `npm root --global`
(or `npm.cmd root --global`) prints the package directory. The same skill is
shipped under `@spencer-life/wslens/.agents/skills/wslens` within that directory;
you can copy that folder instead. npm installation includes the files but does
not register a personal Codex skill or change agent configuration.

Updates to the source do not update a copied skill automatically. Review the
new folder and your local customizations before replacing a personal copy.

For another agent host, use its supported skill discovery mechanism or ask it
to read `SKILL.md` and the linked command reference as manual guidance. Codex
selection syntax does not imply native support in every host.

## What the agent can establish

The skill helps the agent distinguish a diagnostic finding from a failed
command: exit `1` can be useful evidence, and exit `0` can still include skipped
checks. It covers PATH lookup limits, current-environment TCP visibility,
lexical path conversion, redacted reports, and before/after interpretation.

A Windows process, a WSL distribution, and a cloud container see different
environments. Run WSLens where the problem occurs; compare separate reports
when you need both sides. An agent without access to that machine can give
you a command and interpret the resulting report. It cannot inspect the
machine through this skill alone.

WSLens does not repair installations or kill processes. The skill helps the
agent explain remedies and perform only the work covered by your request.
Reports stay local unless you separately share them. See
[privacy and limits](privacy.md) for the data collected and redaction scope.

## Creator provenance and maintenance

Created on **2026-10-10** using the official OpenAI Codex-bundled
[skill creator](https://github.com/openai/codex/blob/34f33e4ada8f417203d87f3b5858c97add8dad6b/codex-rs/skills/src/assets/samples/skill-creator/SKILL.md)
at the current upstream snapshot verified during authoring:
`34f33e4ada8f417203d87f3b5858c97add8dad6b`.
The creator has no separate semantic version. Its instruction update from
August 13, 2026 is newer than the February 9, 2026 copy in the standalone
`openai/skills` catalog. The snapshot pins what was actually used; it does not
claim that future upstream versions are unchanged.

The authoring process read the creator and its `references/openai_yaml.md`,
used its `scripts/init_skill.py` to initialize the folder and interface, and
used its `scripts/quick_validate.py` for structural validation. These are
authoring utilities, not WSLens runtime dependencies or vendored package files.

When updating this skill, keep command guidance aligned with the CLI, preserve
the invocation policy, and use the reviewed creator's validator. For example,
with `WSLENS_CREATOR_DIR` pointing to that reviewed creator directory:

```sh
python "$WSLENS_CREATOR_DIR/scripts/quick_validate.py" .agents/skills/wslens
npm run ci
npm run pack:check
```

The upstream validator requires PyYAML and checks frontmatter, naming, and
unfinished scaffolding. It does not prove command accuracy or good agent
decisions. Review interface metadata and exercise meaningful workflows after
substantial changes. The package check verifies that all three skill files
survive a real pack/install unchanged and that shipped Markdown links resolve.
See [validation evidence](validation.md) and the implementation PR for observed
behavior and current-head results.
