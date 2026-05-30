---
name: transition-to
description: Transition a task to a specific workflow step
---

# /transition-to

Transition a task to a specific step within its current workflow. The task argument accepts a full task UUID or 8-char short ID. The target accepts a full step UUID, an 8-char step short ID, or a step name in the task's current workflow.

## Usage

```bash
# Transition to a step by name in the task's current workflow
vtb transition-to <task-id> <step-name>

# Transition to a step by UUID or 8-char step short ID
vtb transition-to <task-id> <step-id>

# Machine-readable output
vtb transition-to <task-id> <step-name> --json
```

## Arguments

| Argument | Description |
|----------|-------------|
| `task-id` | Task UUID or 8-char short ID |
| `target` | Target step UUID, 8-char short ID, or step name |

## Options

| Flag | Short | Description |
|------|-------|-------------|
| `--force` | `-f` | Override warnings (but not errors) |
| `--skip-validation` | | Bypass workflow transition validation |
| `--json` | | Global flag; output machine-readable JSON instead of human-readable text |

## Finding Step UUIDs

To find available steps or IDs:

```bash
vtb workflow list                    # List all workflows
vtb workflow show <workflow-id>      # See steps with their UUIDs
vtb step list <workflow-id>          # List steps with IDs
```

## Constraints

- The task must already be assigned to the same workflow as the target step
- To change workflows entirely, use `vtb workflow assign <task-id> <workflow-id>`
- Step names are resolved only within the task's current workflow
- Transitions are validated against the step's `transitions_to` graph unless `--skip-validation` is used

## Output

On success:
```
Transitioned task 'abc123' from implementation:coding to review:pending
```

When transitioning to a final step, unblocked tasks are shown:
```
Transitioned task 'abc123' from implementation:coding to implementation:done

Unblocked tasks:
  - def456 (Write unit tests)
  - ghi789 (Update documentation)
```

## See Also

- `/workflow assign` - Assign a workflow to a task (for cross-workflow moves)
