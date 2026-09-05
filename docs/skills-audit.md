# Skills Audit

This audit records the retained embedded skill set, repo-internal skills, and
generation policy for checked-in skill files. It is intentionally separate from
command validation work: command syntax comes from live CLI help, while durable
workflow guidance stays curated.

## Sources of truth

- Command paths, arguments, flags, aliases, and JSON support:
  `cargo run --quiet -p vertebrae-cli -- --help` and
  `cargo run --quiet -p vertebrae-cli -- <command> --help`
- Supported section types and command behavior: live command help plus the
  maintained guide page for the command family.
- Human workflow guidance: project docs, especially `AGENTS.md`,
  `docs/vtb-guide/overview.md`, and repo-specific GUI development notes.
- Project artifact operations: `skills/artifact/SKILL.md` and
  `docs/vtb-guide/artifacts.md`.
- GUI visual-feedback procedure: `.claude/skills/gui-dev/SKILL.md` and the
  Hammerspoon helpers under `hammerspoon/`.

## Generation policy

Generated command skills should be regenerated from live `vtb --help` and
`vtb <command> --help` output rather than copied from older skill text. A
generated skill may include concise examples and behavior notes, but every
command, flag, alias, positional argument, enum value, and JSON behavior must be
derived from live help or the maintained guide page for that command family.

Curated workflow skills can remain hand-authored when they describe working
practice rather than one CLI command. Curated skills must not invent command
syntax; any embedded commands should be periodically checked against the
live CLI help. If a skill combines command reference and practice guidance,
keep the practice text curated and regenerate only the command-reference
portions.

The next regeneration step should treat the table below as exhaustive. Every
embedded `skills/*/SKILL.md` file and repo-internal `.claude/skills/*/SKILL.md`
file has a disposition and source of truth.

Before regenerating, compare the checked-in embedded skills, repo-internal
skills, and command-help coverage against this audit:

```bash
find skills -mindepth 2 -maxdepth 2 -name SKILL.md | sort
find .claude/skills -mindepth 2 -maxdepth 2 -name SKILL.md | sort
cargo run --quiet -p vertebrae-cli -- --help
```

The first command should match the embedded `skills/*` rows in the inventory.
The second command should match repo-internal `.claude/skills/*` rows. The
third should expose each retained command topic.

## Sacrum guide parity findings

The sibling Sacrum checkout is a layout comparison, not command truth. Its
`.claude/skills/*/SKILL.md` tree uses the same one-directory-per-command
pattern, concise YAML frontmatter, command usage blocks, examples, output
notes, and related-command links. Vertebrae keeps those structural choices for
installed skills while deriving command names and flags from the local CLI
help output.

Sacrum skill files that are intentionally **not** copied into Vertebrae:

| Sacrum skill | Vertebrae treatment | Reason |
|---|---|---|
| `start-step` | Fold into `run`, `transition-to`, and execution guide text | Current Vertebrae exposes daemon execution through `run` for one step and TaskRuns through `start-taskrun`; there is no local `start-step` command. |
| `complete-step` | Fold into workflow transition guidance | Current step movement is documented through `transition-to`, workflow assignment, and TaskRun execution; there is no local `complete-step` command. |
| `reject-step` | Fold into transition/workflow guidance | Rejection is modeled as workflow movement or review policy, not a standalone CLI command. |
| `review` | Not installed as a command skill | Human review is represented by workflow/step configuration and task movement; the local CLI has no `review` command. |
| `status` | Not installed as a command skill | Current status inspection is covered by `show`, `list`, and `ready`; there is no top-level `status` command. |
| `implement` | Not installed as a command skill | Implementation workflow is project guidance, not a local CLI command. |

Vertebrae-only or renamed skills:

| Vertebrae skill | Source of truth | Notes |
|---|---|---|
| `run-workflow` | Live help for `start-taskrun` and `stop-taskrun` | File name remains for compatibility with installed skill naming, but the CLI exposes only `start-taskrun` and `stop-taskrun`. |
| `gui-dev` | `.claude/skills/gui-dev/SKILL.md`; `hammerspoon/` helpers and GUI docs | Curated repo-internal workflow guidance with no Sacrum counterpart. |

The parity target is structural: keep the split guide pages and installed skill
shape that worked in Sacrum, but reject stale Sacrum command semantics unless
the local CLI exposes the command.

## Disposition categories

- `keep-generated`: keep the skill, but regenerate command syntax from live CLI
  help and validate examples against the relevant guide page.
- `keep-curated`: keep the skill as hand-authored workflow guidance; validate
  any embedded commands against live help.
- `keep-internal`: keep the skill as repo-internal `.claude/skills/` guidance
  and exclude it from the embedded skills copied by `vtb init`.
- `rewrite`: keep the topic, but rewrite because the current file is not
  aligned with the current live CLI or product shape.
- `remove`: remove the skill from the embedded set, or fold its useful content
  into another retained skill or guide page.
- `merge`: merge this skill into another retained skill because it does not need
  its own installed command guide.

## Inventory

The active inventory includes the project artifact skill below. The
`.agents/plugins/vertebrae-vtb` implementation skill is provider/plugin guidance
and is audited separately from the embedded CLI command skills.

| Skill file | Command/topic | Category | Source of truth | Disposition | Notes |
|---|---|---|---|---|---|
| `skills/add/SKILL.md` | `vtb add` | Command reference | Live `vtb add --help`; `docs/vtb-guide/tasks.md` | keep-generated | Regenerate syntax from live help and keep hierarchy guidance brief. |
| `skills/artifact/SKILL.md` | `vtb artifact ...` | Command reference | Live artifact help; `docs/vtb-guide/artifacts.md` | keep-generated | Project-scoped artifact lookup and attachment syntax. |
| `skills/archive/SKILL.md` | `vtb archive`; `vtb unarchive` | Command reference | Live `vtb archive --help` and `vtb unarchive --help`; `docs/vtb-guide/tasks.md` | keep-generated | `unarchive` is related and can remain in the same skill. |
| `skills/blockers/SKILL.md` | `vtb blockers` | Command reference | Live `vtb blockers --help`; `docs/vtb-guide/dependencies.md` | keep-generated | Verify examples against live help. |
| `skills/check-item/SKILL.md` | `vtb check-item` | Command reference | Live `vtb check-item --help`; `docs/vtb-guide/tasks.md`; `docs/vtb-guide/sections.md` | keep-generated | Keep 1-based checklist indexing. |
| `skills/criterion-ref/SKILL.md` | `vtb criterion-ref` | Command reference | Live `vtb criterion-ref --help`; `docs/vtb-guide/references.md` | keep-generated | Source `--desc` alias from live help. |
| `skills/delete/SKILL.md` | `vtb delete` | Command reference | Live `vtb delete --help`; `docs/vtb-guide/tasks.md` | keep-generated | Destructive warning may remain curated. |
| `skills/depend/SKILL.md` | `vtb depend` | Command reference | Live `vtb depend --help`; `docs/vtb-guide/dependencies.md` | keep-generated | Dependency semantics may stay as short curated context. |
| `skills/execution/SKILL.md` | Removed from embedded skills | Command family reference | Removed CLI command family; `docs/vtb-guide/execution.md` now covers `run` and TaskRuns only | delete | Execution logs are intentionally invisible to the CLI/agent surface for now. |
| `.claude/skills/gui-dev/SKILL.md` | GUI visual-feedback workflow | Repo-internal workflow guidance | `hammerspoon/`; `docs/gui-development.md`; local GUI workflow | keep-internal | Not a CLI command. Keep hand-authored, tracked for this repo, and excluded from embedded consumer installs. |
| `skills/init/SKILL.md` | `vtb init` | Command reference | Live `vtb init --help`; `docs/vtb-guide/project-setup.md` | keep-generated | Keep embedded-skills behavior aligned with docs. |
| `skills/list/SKILL.md` | `vtb list` | Command reference | Live `vtb list --help`; `docs/vtb-guide/tasks.md` | keep-generated | Verify examples against live help. |
| `skills/path/SKILL.md` | `vtb path` | Command reference | Live `vtb path --help`; `docs/vtb-guide/dependencies.md` | keep-generated | Verify examples against live help. |
| `skills/ready/SKILL.md` | `vtb ready` | Command reference | Live `vtb ready --help`; `docs/vtb-guide/tasks.md` | keep-generated | Verify examples against live help. |
| `skills/ref/SKILL.md` | `vtb ref` | Command reference | Live `vtb ref --help`; `docs/vtb-guide/references.md` | keep-generated | File-spec rules should match shared parser behavior. |
| `skills/refs/SKILL.md` | `vtb refs` | Command reference | Live `vtb refs --help`; `docs/vtb-guide/references.md` | keep-generated | Verify examples against live help. |
| `skills/run-workflow/SKILL.md` | `vtb start-taskrun`; `vtb stop-taskrun` | Command reference | Live `vtb start-taskrun --help` and `vtb stop-taskrun --help`; `docs/vtb-guide/execution.md` | keep-generated | File name remains for compatibility, but title and examples use the primary command names only. |
| `skills/run/SKILL.md` | `vtb run` | Command reference | Live `vtb run --help`; `docs/vtb-guide/execution.md` | keep-generated | Distinguish one-step execution from TaskRun. |
| `skills/section/SKILL.md` | `vtb section` | Command reference | Live `vtb section --help`; `docs/vtb-guide/sections.md` | keep-generated | Section type list must be generated from live help and section docs. |
| `skills/sections/SKILL.md` | `vtb sections` | Command reference | Live `vtb sections --help`; `docs/vtb-guide/sections.md` | keep-generated | Verify examples against live help. |
| `skills/step/SKILL.md` | `vtb step ...` | Command family reference | Live `vtb step --help` and subcommand help; `docs/vtb-guide/steps.md` | keep-generated | Regenerate subcommand syntax, especially provider/model flags. |
| `skills/transition-to/SKILL.md` | `vtb transition-to` | Command reference | Live `vtb transition-to --help`; `docs/vtb-guide/workflows.md` | keep-generated | Keep the workflow-assignment distinction explicit. |
| `skills/uncheck-item/SKILL.md` | `vtb uncheck-item` | Command reference | Live `vtb uncheck-item --help`; `docs/vtb-guide/tasks.md`; `docs/vtb-guide/sections.md` | keep-generated | Verify examples against live help. |
| `skills/undepend/SKILL.md` | `vtb undepend` | Command reference | Live `vtb undepend --help`; `docs/vtb-guide/dependencies.md` | keep-generated | Verify examples against live help. |
| `skills/unref/SKILL.md` | `vtb unref` | Command reference | Live `vtb unref --help`; `docs/vtb-guide/references.md` | keep-generated | Regenerate `--all`/file conflict behavior from docs or tests. |
| `skills/unsection/SKILL.md` | `vtb unsection` | Command reference | Live `vtb unsection --help`; `docs/vtb-guide/sections.md` | keep-generated | Multi-instance index behavior must match live CLI. |
| `skills/update/SKILL.md` | `vtb update` | Command reference | Live `vtb update --help`; `docs/vtb-guide/tasks.md`; `docs/vtb-guide/sections.md` | keep-generated | Regenerate section edit/remove tuple syntax from live help and docs. |
| `skills/vtb-show/SKILL.md` | `vtb show` | Command reference | Live `vtb show --help`; `docs/vtb-guide/tasks.md` | keep-generated | Keep the file name if installed skill names must avoid colliding with shell words, but generate from `show`. |
| `skills/workflow/SKILL.md` | `vtb workflow ...` | Command family reference | Live `vtb workflow --help` and subcommand help; `docs/vtb-guide/workflows.md` | keep-generated | Regenerate nested transition syntax from live help and docs. |

## Help coverage notes

Live top-level help should expose every `keep-generated` command skill. It also
includes commands with no standalone skill, such as `unarchive` and nested
command-family subcommands. Those can remain documented inside guide pages or
parent command-family skills unless product onboarding needs a dedicated
installed skill for them.

`start-taskrun` and `stop-taskrun` are the only retained command topics whose
primary command names differ from the skill file name. The
`skills/run-workflow/SKILL.md` title and examples should use those primary names
only; `run-workflow`, `stop`, and `stop-workflow` are no longer CLI aliases.
