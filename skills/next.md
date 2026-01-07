---
description: Complete current task and move to the next one
---

# /next

Complete current task and move to the next one.

## When to use
- After finishing implementation of a task
- To see what was unblocked
- To start the next task in sequence

## Commands

```bash
# Mark current task done (shows unblocked tasks)
vtb done <task-id>

# Start the next task
vtb start <next-task-id>

# If unsure what to work on, check blockers of your goal
vtb blockers <goal-task-id>
```
