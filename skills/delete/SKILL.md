---
name: delete
description: Remove tasks from the database
---

# /delete

Remove tasks from the database. Prefer `vtb archive` for reversible cleanup;
`vtb delete` is destructive.

## Usage

```bash
# Delete a single task; prompts for confirmation
vtb delete <task-id>

# Delete a task and all descendants
vtb delete <task-id> --cascade

# Delete without prompts; children are orphaned unless --cascade is also set
vtb delete <task-id> --force

# Delete a subtree without prompts
vtb delete <task-id> --cascade --force

# Machine-readable output
vtb delete <task-id> --force --json
```

## Options

Use `vtb delete --help` for the live option list. The canonical guide section
in `docs/vtb-guide.md` covers prompts, JSON output, short IDs, and validation
behavior.

## Behavior

- A task with no children prompts `Delete task '<title>'? [y/N]` unless
  `--force` is passed.
- A task with children prompts
  `Task has N children. [C]ascade delete / [O]rphan / [A]bort?` unless
  `--cascade` or `--force` is passed.
- `--cascade` deletes the task and its descendants.
- `--force` without `--cascade` deletes the task and orphans its children.
- If the task blocks other tasks, the command prompts
  `This task blocks N other tasks. Continue? [y/N]` unless `--force` is passed.
- Empty or unrecognized prompt responses cancel the deletion.

## Warnings
- Deleting a task removes its sections and refs.
- `--cascade` deletes the entire subtree.
- Dependencies pointing to deleted tasks are removed.
