---
name: list
description: List and filter tasks
---

# /list

List and filter tasks. Displays tasks in a tree view by default.

## Basic listing

```bash
vtb list                          # All non-archived tasks (tree view)
vtb list --json                   # JSON array of task summaries
vtb list --flat                   # Flat table view
vtb list --status backlog         # By workflow step name
vtb list -s todo -s in_progress   # Repeat status filters with the short alias
vtb list --level epic             # By level: epic, ticket, task
vtb list --priority high          # By priority: low, medium, high, critical
vtb list --tag backend            # By tag (repeatable)
```

## Filtering by workflow

```bash
vtb list --workflow <workflow-id>  # Tasks in a specific workflow UUID or short ID
vtb list --step <step-id>          # Tasks at a specific step UUID or short ID
vtb list -w <wf-id> --step <id>    # Combine workflow and step filters
```

## Filtering by parent

```bash
vtb list --parent <ID>            # Show children of a specific task UUID or short ID
vtb list --root                   # Show only root items (no parent)
```

## Additional options

```bash
vtb list --include-archived       # Include archived items (excluded by default)
vtb list --search "auth"          # Search in title and description
```

## Options

Use `vtb list --help` for the live option list. The canonical guide section in
`docs/vtb-guide.md` covers list-specific filters, JSON output, short IDs, and
validation behavior.

## Note on `--status`

The `--status` flag filters by **workflow step names** (e.g., backlog, todo, in_progress, done), not by a separate global status field. The values depend on which workflow steps are configured in your project.

## Display modes
- **Tree (default)** - Hierarchical view showing parent-child relationships
- **Flat (`--flat`)** - Table view with columns: ID, Level, Workflow, Run, Priority, Title, Tags, and archived marker
