---
name: blockers
description: Show the full dependency chain blocking a task
---

# /blockers

Show the full dependency chain blocking a task.

## Usage

```bash
vtb blockers <task-id>

# Limit depth of traversal
vtb blockers <task-id> --depth 2

# Include blockers already in the done workflow step
vtb blockers <task-id> --all

# Output the blocker tree as JSON
vtb blockers <task-id> --json
```

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--depth` | `-d` | Maximum depth to traverse (unlimited by default) |
| `--all` | `-a` | Include blockers whose current workflow step is `done` |
| `--json` | | Output machine-readable JSON instead of human-readable text |

## Output

Shows recursive tree of all tasks that must be completed before this task can start:

```
Blockers for: abc123 "Deploy to production"
==================================================

def456   task     todo         Run integration tests
    `-- ghi789   task     in_progress  Fix failing unit tests

Total: 2 blocking items
```

With `--json`, the command returns `task_id`, `task_title`, recursive
`blockers` nodes, and `total_count`. Each blocker node includes `id`, `title`,
`level`, `step_name`, and `children`.

## When to use
- Understanding why a task can't transition to in_progress
- Planning work order
- Finding the critical path
- Debugging dependency chains with `--depth` to limit scope
