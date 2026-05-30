---
name: vtb-show
description: Display full task details including metadata, workflow/run state, sections, refs, and relationships
---

# /vtb-show

Display full details of a task including metadata, workflow position, run
state, sections, refs, and relationships.

## Usage

```bash
vtb show <task-id>
vtb --json show <task-id>
vtb show <task-id> --json
```

`<task-id>` accepts a full UUID or an 8-character hex short ID and is resolved
case-insensitively. Use `--json` for structured task-detail JSON instead of
human-readable text; the global JSON flag may appear before or after the
subcommand.

## Output includes

- Task metadata, timestamps, workflow position, and run state
- Description, structured sections, checklist state, and testing-criterion refs
- Code references and relationships: parent, children, blocked by, blocks
- Rejection reason, when present

See `docs/vtb-guide.md#viewing-details` for the canonical output shape,
short-ID behavior, JSON fields, and validation details.
