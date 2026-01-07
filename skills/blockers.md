---
description: Show the full dependency chain blocking a task
---

# /blockers

Show the full dependency chain blocking a task.

## Usage

```bash
vtb blockers <task-id>
```

## Output

Shows recursive tree of all tasks that must be completed before this task can start:

```
Blockers for: abc123 "Deploy to production"
==================================================

def456   task     todo         Run integration tests
    `-- ghi789   task     in_progress  Fix failing unit tests
        `-- jkl012   task     done         Update test fixtures

Total: 3 blocking items
```

## When to use
- Understanding why a task can't start
- Planning work order
- Finding the critical path
