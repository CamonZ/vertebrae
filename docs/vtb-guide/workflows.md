# Workflows

## Workflows and Steps

Workflows define the stages a task progresses through.

### Creating Workflows

```bash
# Basic workflow with inline steps (format: name:model)
vtb workflow add "Implementation" --step Coding:sonnet --step Testing:haiku --step Docs:haiku

# With description and kanban column
vtb workflow add "Code Review" \
  -d "Review and approval process" \
  --step Review:sonnet \
  --step Approved:haiku \
  --kanban-column "In Review"

# Mark as default workflow for new tasks
vtb workflow add "Standard" --step Backlog:sonnet --step Done:haiku --default

# Set display order
vtb workflow add "Triage" --order 1

# Create a workflow first, then add steps later
vtb workflow add "Planning"

# Machine-readable creation result
vtb workflow add "Automation" --json
```

`vtb workflow add` accepts one required positional argument, `<NAME>`.
Inline `--step` values are optional, repeatable, and parsed as
`name:model`; whitespace around each side is trimmed, and the model may contain
additional colons. The command prints `Created workflow: <workflow-id>` by
default. The global `--json` flag returns an operation envelope with
`command: "workflow add"`, `status: "created"`, and top-level `workflow_id`.

| Flag | Description |
|------|-------------|
| `<NAME>` | Required workflow name |
| `-d, --description <DESCRIPTION>` | Optional workflow description |
| `-s, --step <STEPS>` | Inline workflow step in `name:model` format; repeatable |
| `-o, --order <ORDER>` | Display order for sorting workflows; lower values appear first; defaults to `0` |
| `--kanban-column <KANBAN_COLUMN>` | Kanban column used for board placement |
| `--default` | Mark the workflow as the default for new tasks |
| `--json` | Global flag; output machine-readable JSON |

### Managing Workflows

```bash
vtb workflow list                                  # List all workflows
vtb workflow list --json                           # List workflow summaries as JSON
vtb workflow show <workflow-id>                    # See steps and details
vtb workflow show <workflow-id> --json             # Emit workflow detail JSON
vtb workflow update <id> --name "Dev"              # Rename
vtb workflow update <id> --kanban-column "Active"  # Set kanban column
vtb workflow update <id> --kanban-column ""        # Clear kanban column
vtb workflow update <id> --default                 # Mark as default
vtb workflow update <id> --name "Dev" --json       # Emit update envelope
vtb workflow delete <workflow-id>                  # Delete workflow
vtb workflow delete <workflow-id> --json           # Emit delete envelope
```

`vtb workflow list` takes no positional arguments and has no command-specific
options. Its human-readable output is one workflow per line:

```text
<workflow-id> - <name> (<step-count> steps)[default marker][description]
```

The default workflow includes ` [default]`; workflows with descriptions append
` - <description>`. If no workflows exist, the command prints
`No workflows found`. The global `--json` flag returns the raw workflow-summary
array, with `id`, `name`, `description`, `step_count`, and `is_default` fields.

`vtb workflow show` takes one required positional argument, `<ID>`, which is
the workflow ID to show. It accepts a case-insensitive full UUID or 8-character
short ID and has no command-specific flags, short flags, aliases, defaults, or
value enums. Its generated help lists only `<ID>`, the global `--json`, and
`-h` / `--help`. Human-readable output shows the workflow id, name,
description, Default and Final values, kanban column, ordered steps with model
and prompt text, and timestamps.

With the global `--json` flag, `workflow show` returns the raw workflow-detail
object with `id`, `name`, `description`, `is_default`, `is_final`,
`kanban_column`, `steps`, `metadata`, `created_at`, and `updated_at` fields.
Each `steps` entry includes `id`, `name`, `model`, `order`, and `prompt`.
Malformed IDs fail validation before execution; valid UUIDs or short IDs that
do not resolve to a workflow return a validation error.

`vtb workflow update` takes one required positional argument, `<ID>`, which is
the workflow ID to update. It accepts a case-insensitive full UUID or
8-character short ID. The command has no aliases, defaults, or value enums.
Supported update options are:

| Flag | Short | Description |
|------|-------|-------------|
| `--name <NAME>` | `-n` | Set a new workflow name |
| `--description <DESCRIPTION>` | `-d` | Set a new workflow description; conflicts with `--clear-description` |
| `--clear-description` | | Clear the workflow description; conflicts with `--description` |
| `--kanban-column <KANBAN_COLUMN>` | | Set the board column; pass an empty string `""` to clear it |
| `--default` | | Mark this workflow as the default for new tasks; conflicts with `--no-default` |
| `--no-default` | | Unmark this workflow as the default; conflicts with `--default` |
| `--json` | | Global flag; output a machine-readable update envelope |

At least one update option is required. Running `vtb workflow update <id>`
without an update option returns a validation error that names the accepted
update flags. Human-readable success output prints `Updated workflow: <id>`.
With the global `--json` flag, the command returns an operation envelope with
`command: "workflow update"`, `status: "updated"`, and `workflow_id`.
Malformed IDs are rejected before command execution. Unknown or ambiguous short
IDs fail during ID resolution. A full UUID that reaches the service but does
not exist returns a workflow-not-found service error.

`vtb workflow delete` takes one required positional argument, `<ID>`, which is
the workflow ID to delete. It accepts a case-insensitive full UUID or
8-character short ID. The command has no command aliases, short flags, defaults,
or value enums. Its generated help lists only `<ID>`, the global `--json`, and
`-h` / `--help`. Human-readable output prints `Deleted workflow: <id>`.

With the global `--json` flag, `workflow delete` returns an operation envelope
with `command: "workflow delete"`, `status: "deleted"`, and top-level
`workflow_id` containing the lowercased ID passed to the command. Malformed IDs
fail validation before execution; valid UUIDs or short IDs that do not resolve
to a workflow return a validation error from the workflow service.

### Assigning Workflows to Tasks

```bash
vtb workflow assign <task-id> <workflow-id>    # Assign (starts at first step)
vtb workflow unassign <task-id>                # Remove workflow
vtb workflow unassign <task-id> --json         # Machine-readable result
```

`vtb workflow assign` takes two required positional arguments: `<TASK_ID>` and
`<WORKFLOW_ID>`. Both accept case-insensitive full UUIDs or 8-character short
IDs. The command has no aliases, no command-specific flags, no defaults, and no
value enums. Its generated help lists only the two positional arguments, the
global `--json`, and `-h` / `--help`.

On success, workflow assignment sets the task to the specified workflow and
resets the task to that workflow's first step. Human-readable output prints
`Assigned task <task-id> to workflow <workflow-id> at step 1: <first-step-name>`.
With the global `--json` flag, `workflow assign` returns an operation envelope
with `command: "workflow assign"`, `status: "updated"`, `task_id`, and
`workflow_id`.

Malformed IDs are rejected before command execution. Unknown or ambiguous short
IDs fail during ID resolution. A full UUID that reaches the service but does
not exist returns a task- or workflow-not-found service error.

`vtb workflow unassign` takes one required positional argument, `<TASK_ID>`,
which accepts a case-insensitive full UUID or 8-character short ID. The command
has no aliases, no command-specific flags, no defaults, and no value enums. Its
generated help lists only the task positional argument, the global `--json`,
and `-h` / `--help`.

On success, workflow unassignment clears the task's workflow and current step.
Human-readable output prints `Unassigned workflow from task <task-id>`. With
the global `--json` flag, `workflow unassign` returns an operation envelope with
`command: "workflow unassign"`, `status: "updated"`, `task_id`, and
`workflow_id: null`.

Malformed IDs are rejected before command execution. Unknown or ambiguous short
IDs fail during ID resolution. A full UUID that reaches the service but does
not exist returns a task-not-found service error.

---

## Moving Tasks Between Workflows and Steps

### Step Transitions (`transition-to`)

Use `transition-to` to move a task to a specific step in its current workflow.
The target can be a step name, full step UUID, or 8-character step short ID.
Step names are resolved inside the task's current workflow. To move a task to a
different workflow, use `vtb workflow assign <task-id> <workflow-id>` first.

```bash
# Move to a step by name
vtb transition-to <id> backlog
vtb transition-to <id> in_progress

# Move to a step by UUID
vtb transition-to <id> <step-uuid>

# Move to a step by 8-character step short ID
vtb transition-to <id> <step-short-id>

# Force past warnings
vtb transition-to <id> <target> --force

# Bypass validation entirely (escape hatch)
vtb transition-to <id> <target> --skip-validation

# Machine-readable output
vtb transition-to <id> <target> --json
```

`transition-to` validates the requested move against the current step's
`transitions_to` graph unless `--skip-validation` is supplied. The command
allows no-op transitions to the task's current step. If the target step belongs
to a different workflow, the command fails and directs you to `workflow assign`.
When a task reaches a final step, the human-readable output lists dependent
tasks that became unblocked.

### Workflow Transition Rules

Define allowed transitions between workflows:

```bash
# Create transition rule
vtb workflow transition add --label <label> <from-workflow-id> <to-workflow-id>
vtb workflow transition add <from-workflow-id> <to-workflow-id> --label "approve"
vtb workflow transition add <from-workflow-id> <to-workflow-id> -l "approve"

# With target step in destination
vtb workflow transition add <from-workflow-id> <to-workflow-id> \
  --label "escalate" --target-step <step-id>
vtb workflow transition add <from-workflow-id> <to-workflow-id> \
  -l "escalate" -t <step-id>

# Machine-readable output
vtb workflow transition add <from-workflow-id> <to-workflow-id> -l "approve" --json

# List and delete transitions
vtb workflow transition list
vtb workflow transition list --workflow-id <id>
vtb workflow transition list -w <id>
vtb workflow transition list --json
vtb workflow transition delete <from-workflow-id> <to-workflow-id>
vtb workflow transition delete <from-workflow-id> <to-workflow-id> --json
```

`workflow transition add` takes two required positional arguments:
`<from-workflow-id>` and `<to-workflow-id>`. Both workflow IDs accept a
case-insensitive full UUID or 8-character short ID. The optional `--target-step`
value accepts a full UUID or an 8-character short ID.
`--label` (`-l`) is required. `--target-step` (`-t`) is optional and selects the
destination workflow step where tasks should land after the transition. The
global `--json` flag can appear anywhere in the command and returns the created
workflow transition object instead of human-readable text.

`workflow transition list` takes no positional arguments. Its only
command-specific option is `--workflow-id <workflow-id>` (`-w`), which filters
results by source workflow ID. The option accepts a full UUID; clap also
accepts an 8-character short-ID-shaped value, but the list command applies the
filter to the value provided. The command has no command aliases, defaults, or
value enums. Human-readable output prints one transition per line:

```text
<from-workflow> -> <to-workflow> [<label>]
```

Transitions with a destination step append ` -> step:<step-id>`. If no
transitions exist, the command prints `No workflow transitions found`; if a
source workflow filter has no matches, it prints
`No transitions found for workflow <workflow-id>`. With `--json`, the command
returns the raw array of workflow transition objects from the workflow service,
including `id`, `from_workflow`, `to_workflow`, `label`, and `target_step` when
present.

`workflow transition delete` takes two required positional arguments:
`<from-workflow-id>` and `<to-workflow-id>`. Both workflow IDs accept a
case-insensitive full UUID or 8-character short ID. The command has no
command-specific flags, aliases, defaults, or value enums. Human-readable
output confirms the deleted source and target workflow IDs:

```text
Deleted transition from workflow <from-workflow-id> to workflow <to-workflow-id>
```

With `--json`, the command returns an operation result. Short IDs are resolved
before execution, and IDs in JSON output are lowercased:

```json
{
  "command": "workflow transition delete",
  "status": "deleted",
  "from_workflow_id": "<resolved-from-workflow-id>",
  "to_workflow_id": "<resolved-to-workflow-id>"
}
```

If no transition exists from the source workflow to the target workflow, the
workflow service returns a not-found error.

### Step Lifecycle (within a workflow)

Steps exist within a workflow. Use `transition-to` to move a task between steps:

#### Working Through a Workflow

Given a workflow with steps: Coding (order 0) -> Testing (order 1) -> Review (order 2, final):

```bash
# 1. Check current position
vtb show <id>
vtb step list <workflow-id>

# 2. Move through the workflow steps as work progresses
vtb transition-to <id> coding
# ... do the coding work ...
vtb transition-to <id> testing
# ... write and run tests ...
vtb transition-to <id> review
# ... review the work ...
# Transitioning past the final step completes the workflow.
```

#### Handling Rejections

```bash
# Reviewer finds issues during the Review step — send the task back to coding
vtb transition-to <id> coding
# ... fix the issues ...
vtb transition-to <id> testing     # Re-advance through the workflow
```

### Key Rules

- **`transition-to`** is for moving to a step in the current workflow (by name, UUID, or short ID)
- **`workflow assign`** is for changing a task's workflow
- **Never use `vtb update`** for workflow/step changes — always use `transition-to`
- Transitions are validated against workflow rules
- Use `--skip-validation` only as an escape hatch

---
