# Managing tasks

Purpose: find, inspect, update and retire tasks.
Use this when: "show me", "what's next", "rename", "archive", "delete".

## What you can do
- Find: `vtb list` (tree by default; filter by `-l` level, `-s` step name,
  `-t` tag, `-w` workflow, `--parent`, `--root`, `--search`), `vtb ready`
  (highest-level actionable items).
- Inspect: `vtb show <id>` (metadata, workflow position, run status, description, sections).
- Update: `vtb update <id>` (title, description, priority, tags, level, worktree, sections).
- Retire: `vtb archive` / `vtb unarchive`; `vtb delete` (`--cascade` for children).

## How it works
IDs accept a full UUID or an 8-character prefix. `--json` on any command gives
machine-readable output. A task's status follows its workflow step; completion
happens when it reaches a `finish` step.

## Needs approval
`vtb delete` (especially `--cascade`) and moving tasks with `vtb transition-to`.
See [permissions](../permissions.md).

## Gotchas
- Archived tasks are hidden from `vtb list` unless `--include-archived`.
- `vtb list -s` filters by step *name*, `--step` by step ID.

## Related
[Authoring](authoring.md) · [Running](../running/index.md)
