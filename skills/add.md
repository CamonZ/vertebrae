# /add

Create a new task in vertebrae.

## Usage

```bash
# Basic task
vtb add "Task title"

# With level and description
vtb add "Feature title" -l epic -d "Detailed description"

# As child of another task
vtb add "Subtask" --parent <parent-id>

# With dependencies
vtb add "Task" --depends-on <blocker-id>

# With priority and tags
vtb add "Urgent fix" -p critical -t bug -t backend
```

## Hierarchy (use in order)

```
epic       → tickets → tasks
```

| Level | When to use | Example |
|-------|-------------|---------|
| `epic` | Large initiative spanning multiple features | "Refactor auth system" |
| `ticket` | Single deliverable feature | "Implement JWT service" |
| `task` | Unit of work (default) | "Create sign() function" |

## Priorities
- `low`, `medium`, `high`, `critical`
