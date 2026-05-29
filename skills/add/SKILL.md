---
name: add
description: Create a new task in vertebrae
---

# /add

Create a new task in vertebrae.

`vtb add` takes one required positional argument, `<TITLE>`. Quote titles that
contain spaces.

## Usage

```bash
# Basic task
vtb add "Task title"

# With level and description
vtb add "Feature title" -l epic -d "Detailed description"

# As child of another task
vtb add "Subtask" --parent <parent-id>

# With dependencies
vtb add "Task" --depends-on <blocker-id> --depends-on <another-blocker-id>

# With priority and tags
vtb add "Urgent fix" -p critical -t bug -t backend

# Assign to a workflow on creation
vtb add "Task" --workflow <workflow-id>

# Machine-readable output
vtb add "Task title" --json
```

## Options

Use `vtb add --help` for the live option list. The canonical guide section in
`docs/vtb-guide.md` covers add-specific flags, JSON output, short IDs, and
validation behavior.

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
