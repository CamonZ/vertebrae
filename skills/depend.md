---
description: Manage task dependencies
---

# /depend

Manage task dependencies.

## Create dependency

```bash
# Task A depends on task B (B blocks A)
vtb depend <task-a> --on <task-b>
```

## Remove dependency

```bash
vtb undepend <task-a> --from <task-b>
```

## View dependencies

```bash
# What blocks this task (recursive)
vtb blockers <task-id>

# Find path between two tasks
vtb path <from-task> <to-task>
```

## Why dependencies matter
- Prevents starting work before prerequisites are done
- `vtb done` shows what tasks are unblocked
- `vtb blockers` visualizes the full dependency tree
