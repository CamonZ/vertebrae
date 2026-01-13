---
description: List and filter tasks
---

# /list

List and filter tasks. Displays tasks in a tree view by default.

## Basic listing

```bash
vtb list                          # All tasks (tree view)
vtb list --flat                   # Flat table view
vtb list --status todo            # By status
vtb list --status in_progress     # Currently active
vtb list --level epic             # By level
vtb list --priority high          # By priority
vtb list --tag backend            # By tag
```

## Filtering by parent

```bash
vtb list --parent <ID>            # Show children of a specific task
vtb list --parent abc123 --all    # Include done children
vtb list --root                   # Show only root items (no parent)
```

## Additional options

```bash
vtb list --all                    # Include done items (excluded by default)
vtb list --search "auth"          # Search in title and description
```

## Statuses
- `backlog` - Not yet triaged
- `todo` - Ready to work on
- `in_progress` - Currently working
- `pending_review` - Submitted for review
- `done` - Completed
- `rejected` - Rejected (with reason)

## Display modes
- **Tree (default)** - Hierarchical view showing parent-child relationships
- **Flat (`--flat`)** - Table view with columns: ID, Level, Status, Priority, Title, Tags
