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
For status changes, use the dedicated commands:
- `vtb start` - Set to in_progress
- `vtb done` - Set to done
- `vtb block` - Set to blocked

## Important
NEVER use update for status changes
