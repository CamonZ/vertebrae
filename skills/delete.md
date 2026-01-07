---
description: Remove tasks from the database
---

# /delete

Remove tasks from the database.

## Usage

```bash
# Delete single task
vtb delete <task-id>

# Delete task and all children (cascade)
vtb delete <task-id> --cascade
```

## Warnings
- Deleting a task removes its sections and refs
- `--cascade` deletes entire subtree
- Dependencies pointing to deleted tasks are removed
