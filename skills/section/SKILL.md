---
name: section
description: Add structured content to tasks
---

# /section

Add structured content to tasks.

## Add sections

```bash
vtb section [--json] <task-id> <type> "content"
```

Task IDs are case-insensitive. Content must not be empty. Single-instance types
replace the existing section of that type; multi-instance types append a new
section with a zero-based index.

## Section types

| Type | Use for | Cardinality |
|------|---------|-------------|
| `goal` | What this task achieves | Single |
| `context` | Background information | Single |
| `current_behavior` | How it works now | Single |
| `desired_behavior` | How it should work | Single |
| `checklist_item` | Ordered checklist items | Multiple |
| `constraint` | Requirements/limitations | Multiple |
| `testing_criterion` | How to verify success | Multiple |
| `anti_pattern` | What to avoid | Multiple |
| `failure_test` | Expected failure cases | Multiple |

## Examples

```bash
vtb section abc123 goal "Implement user authentication"
vtb section abc123 checklist_item "Add User model"
vtb section abc123 checklist_item "Create login endpoint"
vtb section abc123 constraint "Must use bcrypt for passwords"
vtb section abc123 testing_criterion "Login returns JWT token"
vtb section abc123 checklist_item "Run focused validation" --json
```

## View/remove sections

```bash
vtb sections <task-id>                          # List all
vtb sections <task-id> --type checklist_item     # Filter by type
vtb unsection <task-id> goal                    # Remove single-instance section
vtb unsection <task-id> checklist_item --index 2 # Remove multi-instance by index (0-based)
```
