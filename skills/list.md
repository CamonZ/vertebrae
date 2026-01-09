---
description: List and filter tasks
---

# /list

List and filter tasks.

## Basic listing

```bash
vtb list                          # All tasks
vtb list --status todo            # By status
vtb list --status in_progress     # Currently active
vtb list --level epic             # By level
vtb list --priority high          # By priority
vtb list --tag backend            # By tag
```

## Statuses
- `backlog` - Not yet triaged
- `todo` - Ready to work on
- `in_progress` - Currently working
- `pending_review` - Submitted for review
- `done` - Completed
- `rejected` - Rejected (with reason)

## Output columns
- ID, Level, Status, Priority, Title, Tags
