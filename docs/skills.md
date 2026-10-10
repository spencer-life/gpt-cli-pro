# Discover and use skills

## WSLens skill in this repository

Use [$wslens](../.agents/skills/wslens/SKILL.md) for Windows/WSL environment
diagnosis, PATH selection, local TCP ports, path translation, and report
interpretation. It is checked in at `.agents/skills/wslens`, with its command
reference and Codex interface metadata, and is also included in the npm package.
The [agent setup guide](agent-skill.md) covers discovery, optional personal
installation, examples, validation, and the official creator revision used.
The skill guides CLI usage; contribution work still follows `AGENTS.md` and
the owning issue.

## Discover other relevant skills

Skills provide task-specific instructions and resources. Start with available
metadata from the session, repository `.agents/skills`, user `~/.agents/skills`,
and configured legacy/plugin roots. Do not scan unrelated home directories. Use
metadata and task context to choose only skills that materially improve the
work. Load the full `SKILL.md` and only the supporting references needed for the
current task before following a skill. Prefer a useful skill already available in
the project, session, or machine.

Before CLI/browser fallbacks, inspect connected plugins and MCP capabilities.
Prefer relevant [Vercel plugin](https://vercel.com/plugin) skills and knowledge
when exposed. Use available [Vercel MCP documentation search](https://vercel.com/docs/agent-resources/vercel-mcp/tools)
for Vercel product docs; Skills.sh discovery is a separate capability. Choose
actual exposed tools and schemas. Check access in each session; a ChatGPT
connection does not guarantee Codex Cloud access.

During setup, when stack or task needs materially change, and whenever work
reveals a useful remaining gap, search for a fitting skill. Existing skills may
already cover the need; ecosystem search is for concrete gaps, not a setup ritual.
Invoke `$find-skills` when available; otherwise use the official
[skills CLI](https://github.com/vercel-labs/skills) with an existing compatible
Node runtime, or search
[skills.sh](https://skills.sh/vercel-labs/skills/find-skills) in a browser. CLI
release `1.7.0` requires Node `>=22.20`; do not add Node only for discovery.
Rankings suggest candidates, but fit depends on reviewing source, tools/runtime,
license, and instructions against project needs and user/repository authority.
Use official sources where available. Browser-only: review the source repository's
full `SKILL.md` and needed references at the same reviewed ref.

For occasional use, a one-time prompt or reviewed source may be enough. These
commands are choices, not a required sequence:

```sh
npx --yes skills@1.7.0 find "<focused query>"
npx --yes skills@1.7.0 add owner/repo --list
npx --yes skills@1.7.0 use owner/repo --skill skill-name
npx --yes skills@1.7.0 add owner/repo --skill skill-name --agent codex --yes --copy
```

The `use` command outputs the full `SKILL.md` but only temporary paths and names
for its references; do not pass `--agent`, which launches another CLI. Supply
needed reference contents when using that prompt elsewhere. For repeated team
use, prefer a reviewed project-scoped install. Run it from the intended repository
root and inspect installed paths and scope before committing. It creates
`skills-lock.json` with source, source type, skill path, and computed hash; this
does not pin an immutable upstream commit. Track the full skill/resources and
lock file for Cloud clones. For every durable selected skill, including one
available globally, add a short route to relevant `AGENTS.md`: trigger,
skill/source, invocation/fallback. Record the reviewed upstream source and its
immutable ref where available; include required license and attribution when
tracking third-party content. Review installed content before use. Do not copy
skill bodies, personal absolute paths, or long catalogues into guidance.

Preserve each skill's enabled/disabled state and invocation settings; respect its
trigger, scope, and any user disablement. Use the host's supported explicit
selector for native explicit-only selection: `$skill-name` in Codex task or
delegation inputs, or ChatGPT's `@` skill selector when available. An `AGENTS.md`
mention alone is not native activation. When task or project instructions authorize
selected-skill guidance but native invocation is unavailable, read and apply the
full skill and needed references as manual guidance. Do not bypass a user or
skill's explicit-selection requirement, change flags, claim native activation, or
infer tools or authority. Otherwise use official documentation or hand off missing
access or tools. The CLI's Codex global target (`~/.codex/skills`) may differ from
`~/.agents/skills`; its listing alone is incomplete.
A selector such as `owner/repo@skill-name` names a skill, not a pinned version.

For substantive JavaScript or TypeScript work with installed dependencies, also
follow [Intent guidance](https://github.com/spencer-life/project-template/blob/main/docs/stacks.md#dependency-guidance-and-tanstack). Intent
discovers dependency-provided, versioned guidance and complements project skill
discovery.

References: [skills CLI](https://github.com/vercel-labs/skills),
[find-skills](https://skills.sh/vercel-labs/skills/find-skills), and
[ChatGPT skills](https://learn.chatgpt.com/docs/build-skills).
