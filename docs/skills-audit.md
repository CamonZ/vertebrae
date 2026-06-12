# Skills Audit

This audit records the retained skill set and generation policy for the
checked-in `skills/*/SKILL.md` files. It is intentionally separate from command
validation work: command syntax comes from the CLI manifest or live help, while
durable workflow guidance stays curated.

## Sources of truth

- Command paths, arguments, flags, aliases, JSON support, and supported section
  types: `cargo run --quiet -p vertebrae-cli -- manifest print`
- Validation of command examples in docs and skills:
  `cargo run --quiet -p vertebrae-cli -- manifest validate-docs --repo-root .`
- Human workflow guidance: project docs, especially `AGENTS.md`,
  `docs/vtb-guide/overview.md`, and repo-specific GUI development notes.
- GUI visual-feedback procedure: `skills/gui-dev/SKILL.md` and the
  Hammerspoon helpers under `hammerspoon/`.

## Generation policy

Generated command skills should be regenerated from the manifest rather than
copied from older skill text. A generated skill may include concise examples and
behavior notes, but every command, flag, alias, positional argument, enum value,
and JSON behavior must be derived from the manifest or live `--help`.

Curated workflow skills can remain hand-authored when they describe working
practice rather than one CLI command. Curated skills must not invent command
syntax; any embedded commands should be periodically checked against the
manifest. If a skill combines command reference and practice guidance, keep the
practice text curated and regenerate only the command-reference portions.

The next regeneration step should treat the table below as exhaustive. Every
existing `skills/*/SKILL.md` file has a disposition and source of truth.

Before regenerating, compare the checked-in skills and manifest hook coverage
against this audit:

```bash
find skills -mindepth 2 -maxdepth 2 -name SKILL.md | sort
cargo run --quiet -p vertebrae-cli -- manifest print \
  | jq -r '.commands[] | [(.path | join(" ")), (.examples_hook // "NO_HOOK")] | @tsv'
```

The first command should match the inventory's `Skill file` column. The second
should match the manifest coverage notes below, including shared hooks for
commands such as `start-taskrun` and `stop-taskrun`.

## Sacrum guide parity findings

The sibling Sacrum checkout is a layout comparison, not command truth. Its
`.claude/skills/*/SKILL.md` tree uses the same one-directory-per-command
pattern, concise YAML frontmatter, command usage blocks, examples, output
notes, and related-command links. Vertebrae keeps those structural choices for
installed skills while deriving command names and flags from the local CLI
manifest.

Sacrum skill files that are intentionally **not** copied into Vertebrae:

| Sacrum skill | Vertebrae treatment | Reason |
|---|---|---|
| `start-step` | Fold into `run`, `transition-to`, and execution guide text | Current Vertebrae exposes daemon execution through `run` for one step and TaskRuns through `start-taskrun`; there is no local `start-step` command. |
| `complete-step` | Fold into workflow transition guidance | Current step movement is documented through `transition-to`, workflow assignment, and TaskRun execution; there is no local `complete-step` command. |
| `reject-step` | Fold into transition/workflow guidance | Rejection is modeled as workflow movement or review policy, not a standalone CLI command in the manifest. |
| `review` | Not installed as a command skill | Human review is represented by workflow/step configuration and task movement; the local manifest has no `review` command. |
| `status` | Not installed as a command skill | Current status inspection is covered by `show`, `list`, `ready`, and `execution`; there is no top-level `status` command. |
| `implement` | Not installed as a command skill | Implementation workflow is project guidance, not a local CLI command. |

Vertebrae-only or renamed skills:

| Vertebrae skill | Source of truth | Notes |
|---|---|---|
| `run-workflow` | Manifest hooks for `start-taskrun` and `stop-taskrun` | File name remains for compatibility with installed skill naming, but examples prefer `start-taskrun` and `stop-taskrun`; `run-workflow`, `stop`, and `stop-workflow` are documented as aliases. |
| `gui-dev` | `hammerspoon/` helpers and GUI docs | Curated workflow guidance with no Sacrum counterpart. |

The parity target is structural: keep the split guide pages and installed skill
shape that worked in Sacrum, but reject stale Sacrum command semantics unless
the local manifest exposes the command.

## Disposition categories

- `keep-generated`: keep the skill, but regenerate command syntax from the CLI
  manifest and validate examples.
- `keep-curated`: keep the skill as hand-authored workflow guidance; validate
  any embedded commands against manifest/live help.
- `rewrite`: keep the topic, but rewrite because the current file is not
  aligned with the current manifest or product shape.
- `remove`: remove the skill from the embedded set, or fold its useful content
  into another retained skill or guide page.
- `merge`: merge this skill into another retained skill because it does not need
  its own installed command guide.

## Inventory

| Skill file | Command/topic | Category | Source of truth | Disposition | Notes |
|---|---|---|---|---|---|
| `skills/add/SKILL.md` | `vtb add` | Command reference | CLI manifest `add`; `docs/vtb-guide/tasks.md` | keep-generated | Manifest hook exists. Regenerate syntax and keep hierarchy guidance brief. |
| `skills/archive/SKILL.md` | `vtb archive`; `vtb unarchive` | Command reference | CLI manifest `archive` and `unarchive`; `docs/vtb-guide/tasks.md` | keep-generated | `archive` has an examples hook; `unarchive` is related and can remain in the same skill. |
| `skills/blockers/SKILL.md` | `vtb blockers` | Command reference | CLI manifest `blockers`; `docs/vtb-guide/dependencies.md` | keep-generated | Manifest hook exists. |
| `skills/check-item/SKILL.md` | `vtb check-item` | Command reference | CLI manifest `check-item`; `docs/vtb-guide/tasks.md`; `docs/vtb-guide/sections.md` | keep-generated | Manifest hook exists; keep 1-based checklist indexing. |
| `skills/criterion-ref/SKILL.md` | `vtb criterion-ref` | Command reference | CLI manifest `criterion-ref`; `docs/vtb-guide/references.md` | keep-generated | Manifest hook exists; source `--desc` alias from manifest. |
| `skills/delete/SKILL.md` | `vtb delete` | Command reference | CLI manifest `delete`; `docs/vtb-guide/tasks.md` | keep-generated | Manifest hook exists; destructive warning may remain curated. |
| `skills/depend/SKILL.md` | `vtb depend` | Command reference | CLI manifest `depend`; `docs/vtb-guide/dependencies.md` | keep-generated | Manifest hook exists; dependency semantics may stay as short curated context. |
| `skills/execution/SKILL.md` | `vtb execution ...` | Command family reference | CLI manifest `execution` and subcommands; `docs/vtb-guide/execution.md` | keep-generated | Manifest hook exists on the parent command. Regenerate subcommand syntax from manifest. |
| `skills/gui-dev/SKILL.md` | GUI visual-feedback workflow | Curated workflow guidance | `hammerspoon/`; `docs/gui-development.md`; local GUI workflow | keep-curated | Not a CLI command. Keep hand-authored and validate embedded setup commands manually. |
| `skills/init/SKILL.md` | `vtb init` | Command reference | CLI manifest `init`; `docs/vtb-guide/project-setup.md` | keep-generated | Manifest hook exists. Keep embedded-skills behavior aligned with docs. |
| `skills/list/SKILL.md` | `vtb list` | Command reference | CLI manifest `list`; `docs/vtb-guide/tasks.md` | keep-generated | Manifest hook exists. |
| `skills/path/SKILL.md` | `vtb path` | Command reference | CLI manifest `path`; `docs/vtb-guide/dependencies.md` | keep-generated | Manifest hook exists. |
| `skills/ready/SKILL.md` | `vtb ready` | Command reference | CLI manifest `ready`; `docs/vtb-guide/tasks.md` | keep-generated | Manifest hook exists. |
| `skills/ref/SKILL.md` | `vtb ref` | Command reference | CLI manifest `ref`; `docs/vtb-guide/references.md` | keep-generated | Manifest hook exists; file-spec rules should match shared parser behavior. |
| `skills/refs/SKILL.md` | `vtb refs` | Command reference | CLI manifest `refs`; `docs/vtb-guide/references.md` | keep-generated | Manifest hook exists. |
| `skills/run-workflow/SKILL.md` | `vtb start-taskrun`; `vtb stop-taskrun`; compatibility aliases | Command reference | CLI manifest `start-taskrun` and `stop-taskrun`; `docs/vtb-guide/execution.md` | rewrite | Manifest hooks map both primary TaskRun commands to this skill. Rewrite around the primary command names and treat `run-workflow`, `stop`, and `stop-workflow` as compatibility syntax. |
| `skills/run/SKILL.md` | `vtb run` | Command reference | CLI manifest `run`; `docs/vtb-guide/execution.md` | keep-generated | Manifest hook exists; distinguish one-step execution from TaskRun. |
| `skills/section/SKILL.md` | `vtb section` | Command reference | CLI manifest `section`; manifest section types; `docs/vtb-guide/sections.md` | keep-generated | Manifest hook exists; section type list must be generated from manifest metadata. |
| `skills/sections/SKILL.md` | `vtb sections` | Command reference | CLI manifest `sections`; manifest section types; `docs/vtb-guide/sections.md` | keep-generated | Manifest hook exists. |
| `skills/step/SKILL.md` | `vtb step ...` | Command family reference | CLI manifest `step` and subcommands; `docs/vtb-guide/steps.md` | keep-generated | Manifest hook exists on the parent command. Regenerate subcommand syntax, especially provider/model flags. |
| `skills/transition-to/SKILL.md` | `vtb transition-to` | Command reference | CLI manifest `transition-to`; `docs/vtb-guide/workflows.md` | keep-generated | Manifest hook exists; keep the workflow-assignment distinction explicit. |
| `skills/uncheck-item/SKILL.md` | `vtb uncheck-item` | Command reference | CLI manifest `uncheck-item`; `docs/vtb-guide/tasks.md`; `docs/vtb-guide/sections.md` | keep-generated | Manifest hook exists. |
| `skills/undepend/SKILL.md` | `vtb undepend` | Command reference | CLI manifest `undepend`; `docs/vtb-guide/dependencies.md` | keep-generated | Manifest hook exists. |
| `skills/unref/SKILL.md` | `vtb unref` | Command reference | CLI manifest `unref`; `docs/vtb-guide/references.md` | keep-generated | Manifest hook exists; regenerate `--all`/file conflict behavior from docs or tests. |
| `skills/unsection/SKILL.md` | `vtb unsection` | Command reference | CLI manifest `unsection`; manifest section types; `docs/vtb-guide/sections.md` | keep-generated | Manifest hook exists; multi-instance index behavior must match live CLI. |
| `skills/update/SKILL.md` | `vtb update` | Command reference | CLI manifest `update`; `docs/vtb-guide/tasks.md`; `docs/vtb-guide/sections.md` | keep-generated | Manifest hook exists; regenerate section edit/remove tuple syntax from manifest/help. |
| `skills/vtb-show/SKILL.md` | `vtb show` | Command reference | CLI manifest `show`; `docs/vtb-guide/tasks.md` | keep-generated | Manifest hook maps `show` to this file. Keep the file name if installed skill names must avoid colliding with shell words, but generate from `show`. |
| `skills/workflow/SKILL.md` | `vtb workflow ...` | Command family reference | CLI manifest `workflow` and subcommands; `docs/vtb-guide/workflows.md` | keep-generated | Manifest hook exists on the parent command. Regenerate nested transition syntax from manifest. |

## Manifest coverage notes

The current manifest has examples hooks for every `keep-generated` command skill.
It also includes commands with no standalone skill or examples hook:
`manifest`, `unarchive`, and nested command-family subcommands. Those can
remain documented inside guide pages or parent command-family skills unless
product onboarding needs a dedicated installed skill for them.

`start-taskrun` and `stop-taskrun` are the only retained command topics whose
primary command names differ from the skill file name. The manifest maps both
commands to `skills/run-workflow/SKILL.md`; the skill title and examples should
prefer the primary names while treating `run-workflow`, `stop`, and
`stop-workflow` as compatibility syntax because the manifest exposes them as
visible aliases.
