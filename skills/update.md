---
description: Modify existing task fields
---

# /update

Modify existing task fields.

## Usage

```bash
# Update title
vtb update <task-id> --title "New title"

# Update description
vtb update <task-id> --description "New description"

# Change priority
vtb update <task-id> --priority high

# Add/replace tags
vtb update <task-id> --tag new-tag

# Change level
vtb update <task-id> --level ticket
```

## Note
For status changes, use the unified transition command:
```bash
vtb transition-to <task-id> <status>
```

Available statuses: `todo`, `in_progress`, `pending_review`, `done`, `rejected`

Examples:
- `vtb transition-to <id> in_progress` - Start working
- `vtb transition-to <id> done` - Complete task
- `vtb transition-to <id> rejected --reason "reason"` - Reject task

## Important
NEVER use update for status changes - use `transition-to` instead
