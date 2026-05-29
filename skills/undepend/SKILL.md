---
name: undepend
description: Remove a dependency between tasks
---

# /undepend

Remove a dependency relationship between tasks.

## Usage

```bash
# Task A no longer depends on task B
vtb undepend <task-a> --on <task-b>

# Short IDs are accepted anywhere a task ID is accepted
vtb undepend <task-a-short-id> --on <task-b-short-id>

# Machine-readable output
vtb undepend <task-a> --on <task-b> --json
```

## Options

Use `vtb undepend --help` for the live option list. The canonical guide section
in `docs/vtb-guide.md` covers JSON output, short IDs, aliases,
missing-dependency behavior, and validation behavior.

## Behavior

- If the dependency exists, it is removed
- If the dependency does not exist, a warning is shown (not an error)

## Related commands

```bash
vtb depend <task-a> --on <task-b>    # Create dependency
vtb blockers <task-id>               # View dependency chain
vtb path <from> <to>                 # Find dependency path
```
