---
name: workflow
description: Manage workflows for task progression
---

# /workflow

Manage workflows that define how tasks progress through steps.

> **Short IDs:** Every workflow/step/task argument accepts either a full UUID
> or an 8-character short ID (the first segment of the UUID). The CLI resolves
> short IDs uniformly across tasks, workflows, and steps.

**Start here to understand available workflows:**
```bash
vtb workflow list                    # See all configured workflows
vtb workflow show <workflow-id>      # See steps within a workflow
```

## Subcommands

| Command | Description |
|---------|-------------|
| `workflow add` | Create a new workflow |
| `workflow list` | List all workflows |
| `workflow show` | Show workflow details |
| `workflow update` | Update workflow properties |
| `workflow delete` | Delete a workflow |
| `workflow export` | Export a portable workflow bundle |
| `workflow import` | Preflight and import a portable workflow bundle |
| `workflow assign` | Assign a task to a workflow |
| `workflow unassign` | Remove workflow from a task |
| `workflow transition add` | Create a transition between workflows |
| `workflow transition list` | List workflow transitions |
| `workflow transition delete` | Delete a workflow transition |

---

## workflow export

```bash
vtb workflow export --workflow <workflow-id> --output workflow.json
vtb workflow export --all --output workflows.json
```

Export selection is explicit: choose exactly one workflow UUID with
`--workflow <workflow-id>` or choose the complete project graph with `--all`.
The selector does not accept workflow names, and exporting a named subset is
not currently supported. A single-workflow export is a closed bundle: it fails
when outgoing workflow transitions or route targets refer to another workflow;
use `--all` when the selected graph has cross-workflow references.

## workflow import

Import a versioned JSON bundle into the active project:

```bash
vtb workflow import workflows.json
vtb workflow import workflows.json --dry-run
vtb workflow import workflows.json --json
```

The command validates the manifest locally, checks destination workflow names
using create-only semantics, and submits one Sacrum bulk mutation only after a
clean preflight. Existing or duplicate workflow names fail; imports never
overwrite, merge, assign tasks, or delete rows implicitly. `--dry-run` performs
only read-only checks and reports counts, the create plan, conflicts, proposed
default status, warnings, and no generated IDs. It does not reserve names or
guarantee a later commit. Sacrum remains authoritative for project access,
graph validation, defaults, and races after preflight.

Committed output reports `status: committed` and complete workflow and
`workflow_ref/step_ref` mappings. JSON output reports `status: dry-run` or
`committed`; mappings are included only after a successful bulk response.
Malformed/unreadable files, unsupported versions, duplicate or dangling refs,
conflicting names, backend rejection, and transport loss return nonzero. The
CLI does not retry an uncertain non-idempotent import or fall back to
incremental creation.

## Export/import round trips

For a portable graph migration, export the complete source graph, preflight the
bundle in the destination, commit it, and export the destination again:

```bash
vtb workflow export --all --output source-workflows.json
vtb workflow import source-workflows.json --dry-run --json
vtb workflow import source-workflows.json --json
vtb workflow export --all --output destination-workflows.json
```

The V1 bundle preserves workflow and step order, initial steps, step and
workflow edges, edge labels, route rules and defaults, workflow metadata,
agent configuration, prompts, output schemas, persistence options, and other
opaque JSON values. Import remaps persistence IDs; compare canonical semantic
content rather than raw IDs or timestamps. Use the returned workflow and
`workflow_ref/step_ref` mappings to inspect the destination graph independently
so matching exporter and importer omissions cannot make a round-trip test pass.

The rich-graph acceptance fixture includes multiple workflows, every supported
step type, distinct goal and prompt values including valid null and empty
prompts, nested metadata/configuration, strict schemas, persistence options,
route rule/default targets, labels, and explicit cross-workflow entry steps.
Run this coverage only against the isolated Docker Sacrum environment; do not
use the local task-management database as the acceptance backend.

---

## workflow add

Create a new workflow, optionally with inline steps.

```bash
# Basic workflow with steps
vtb workflow add "Code Review" --step review:sonnet --step approved:haiku

# Create the workflow first and add steps later
vtb workflow add "Planning"

# Group related workflows under a factory name
vtb workflow add "Factory Build" --factory-name "Shared Factory"

# Machine-readable creation result
vtb workflow add "Automation" --json
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--description <DESCRIPTION>` | `-d` | Optional workflow description |
| `--step <STEPS>` | `-s` | Step in `name:model` format (repeatable) |
| `--order <ORDER>` | `-o` | Display order; lower values appear first (default: 0) |
| `--kanban-column <KANBAN_COLUMN>` | | Kanban column for board placement |
| `--factory-name <FACTORY_NAME>` | | Optional factory name used to group related workflows |
| `--default` | | Mark this workflow as the default for new tasks |
| `--json` | | Global flag; output machine-readable JSON |

The `<NAME>` positional argument is required. `--step` is optional; when
omitted, the workflow is created without initial steps and can be populated with
`vtb step add --workflow <workflow-id> <name>`. Step values trim whitespace and
split on the first colon, so `step:model:extra` uses `model:extra` as the
model. `--json` returns an operation envelope with `command`, `status`, and
`workflow_id`.

---

## workflow list

List all defined workflows.

```bash
vtb workflow list
vtb workflow list --json
```

`workflow list` takes no positional arguments and has no command-specific
options. The global `--json` flag returns workflow summaries as structured JSON.

Human-readable output prints one workflow per line:

```text
<workflow-id> - <name> (<step-count> steps)[default marker][description]
```

The default workflow includes ` [default]` after the step count. Workflows with
a description append ` - <description>`. If no workflows exist, the command
prints `No workflows found`. With `--json`, the command returns the raw array of
workflow summaries with `id`, `name`, `description`, `step_count`, and
`is_default` fields.

---

## workflow show

Show detailed workflow information including steps.

```bash
vtb workflow show <workflow-id>
vtb workflow show <workflow-id> --json
vtb --json workflow show <workflow-id>
```

`workflow show` has one required positional argument:

| Argument/Option | Alias | Required | Notes |
| --- | --- | --- | --- |
| `<ID>` | | Yes | Workflow ID to show; accepts a case-insensitive full UUID or 8-character short ID. |
| `--json` | | No | Global flag; output the workflow detail object as JSON. |

There are no command aliases, short flags, defaults, or value enums for
`workflow show`. Human-readable output includes the workflow id, name,
description, Default value, kanban column, factory name, ordered steps with
model and prompt text, and timestamps. With `--json`, the command returns the
raw workflow-detail object with `id`, `name`, `description`, `is_default`,
`kanban_column`, `factory_name`, `steps`, `metadata`, `created_at`, and
`updated_at` fields.

Malformed IDs are rejected before command execution. A valid full UUID or short
ID that does not resolve to a workflow returns a validation error.

---

## workflow update

Update workflow properties.

```bash
vtb workflow update <id> --name "Development"
vtb workflow update <id> --kanban-column ""
vtb workflow update <id> --factory-name "Shared Factory"
vtb workflow update <id> --factory-name ""
vtb workflow update <id> --name "Development" --json
```

### Options

| Argument/Option | Alias | Required | Notes |
| --- | --- | --- | --- |
| `<ID>` | | Yes | Workflow ID to update; accepts a case-insensitive full UUID or 8-character short ID. |
| `--name <NAME>` | `-n` | No | New workflow name. |
| `--description <DESCRIPTION>` | `-d` | No | New description; conflicts with `--clear-description`. |
| `--clear-description` | | No | Remove description; conflicts with `--description`. |
| `--kanban-column <KANBAN_COLUMN>` | | No | Set board column; pass an empty string `""` to clear. |
| `--factory-name <FACTORY_NAME>` | | No | Set factory name; pass an empty string `""` to clear. |
| `--default` | | No | Mark this workflow as the default for new tasks; conflicts with `--no-default`. |
| `--no-default` | | No | Unmark this workflow as the default; conflicts with `--default`. |
| `--json` | | No | Global flag; returns an operation envelope with `command`, `status`, and `workflow_id`. |

At least one update option is required. Running `vtb workflow update <id>` without
`--name`, `--description`, `--clear-description`, `--kanban-column`,
`--factory-name`, `--default`, or `--no-default` returns a validation error.

---

## workflow delete

Delete a workflow.

```bash
vtb workflow delete <workflow-id>
vtb workflow delete <workflow-id> --json
```

Arguments and options:

| Argument/Option | Alias | Required | Notes |
| --- | --- | --- | --- |
| `<ID>` | | Yes | Workflow ID to delete; accepts a case-insensitive full UUID or 8-character short ID. |
| `--json` | | No | Global flag; returns an operation envelope with `command`, `status`, and `workflow_id`. |

There are no command aliases, short flags, defaults, or value enums for
`workflow delete`. Human-readable output prints `Deleted workflow: <id>`.
With `--json`, successful deletion returns `command: "workflow delete"`,
`status: "deleted"`, and the lowercased `workflow_id`.

Malformed IDs are rejected before command execution. A valid full UUID or short
ID that does not resolve to a workflow returns a validation error from the
workflow service.

---

## workflow assign

Assign a task to a workflow (starts at first step).

```bash
vtb workflow assign <task-id> <workflow-id>
vtb workflow assign <task-id> <workflow-id> --json
```

| Argument/Option | Alias | Required | Notes |
| --- | --- | --- | --- |
| `<task-id>` | | Yes | Task ID to assign; accepts a case-insensitive full UUID or 8-character short ID. |
| `<workflow-id>` | | Yes | Workflow ID to assign; accepts a case-insensitive full UUID or 8-character short ID. |
| `--json` | | No | Global flag; returns an operation envelope with `command: "workflow assign"`, `status: "updated"`, `task_id`, and `workflow_id`. |
| `--help` | `-h` | No | Print help. |

The command has no aliases, short flags other than help, command-specific
flags, defaults, or value enums. Assignment resets the task to the assigned
workflow's first step. Human-readable success output prints
`Assigned task <task-id> to workflow <workflow-id> at step 1: <first-step-name>`.

Malformed IDs are rejected before command execution. Unknown or ambiguous short
IDs fail during ID resolution. A full UUID that reaches the service but does
not exist returns a task- or workflow-not-found service error.

---

## workflow unassign

Remove workflow assignment from a task.

```bash
vtb workflow unassign <task-id>
vtb workflow unassign <task-id> --json
```

| Argument/Option | Alias | Required | Notes |
| --- | --- | --- | --- |
| `<task-id>` | | Yes | Task ID to unassign; accepts a case-insensitive full UUID or 8-character short ID. |
| `--json` | | No | Global flag; returns an operation envelope with `command: "workflow unassign"`, `status: "updated"`, `task_id`, and `workflow_id: null`. |
| `--help` | `-h` | No | Print help. |

The command has no aliases, command-specific flags, defaults, or value enums.
Unassignment clears the task's workflow and current step. Human-readable success
output prints `Unassigned workflow from task <task-id>`.

Malformed IDs are rejected before command execution. Unknown or ambiguous short
IDs fail during ID resolution. A full UUID that reaches the service but does
not exist returns a task-not-found service error.

---

## workflow transition add

Create a transition definition between two workflows.

```bash
# Required syntax
vtb workflow transition add --label <label> <from-workflow-id> <to-workflow-id>

# Basic transition (full UUIDs or 8-character short IDs)
vtb workflow transition add <from-workflow-id> <to-workflow-id> --label "approve"
vtb workflow transition add <from-workflow-id> <to-workflow-id> -l "approve"

# With target step in destination workflow
vtb workflow transition add <from-workflow-id> <to-workflow-id> --label "escalate" --target-step <step-id>
vtb workflow transition add <from-workflow-id> <to-workflow-id> -l "escalate" -t <step-id>

# Machine-readable output
vtb workflow transition add <from-workflow-id> <to-workflow-id> -l "approve" --json
```

Arguments and options:

| Argument/Option | Alias | Required | Notes |
| --- | --- | --- | --- |
| `<from-workflow-id>` | | Yes | Source workflow ID; accepts a case-insensitive full UUID or 8-character short ID. |
| `<to-workflow-id>` | | Yes | Target workflow ID; accepts a case-insensitive full UUID or 8-character short ID. |
| `--label <label>` | `-l` | Yes | Transition label, for example `approve`, `reject`, or `escalate`. |
| `--target-step <step-id>` | `-t` | No | Destination workflow step to start at; accepts a full UUID or 8-character short ID. |
| `--json` | | No | Global flag; returns the created workflow transition object as JSON. |

## workflow transition list

List workflow transitions.

```bash
vtb workflow transition list
vtb workflow transition list --workflow-id <workflow-id>
vtb workflow transition list -w <workflow-id>
vtb workflow transition list --json
```

Arguments and options:

| Argument/Option | Alias | Required | Notes |
| --- | --- | --- | --- |
| `--workflow-id <workflow-id>` | `-w` | No | Filter by source workflow ID; accepts a full UUID. Clap also accepts an 8-character short-ID-shaped value, but the list command applies the filter to the value provided. |
| `--json` | | No | Global flag; returns the raw workflow transition array as JSON. |
| `--help` | `-h` | No | Print help. |

The command takes no positional arguments and has no command aliases, defaults,
or value enums. Human-readable output prints one transition per line as
`<from-workflow> -> <to-workflow> [<label>]`; transitions with a destination
step append ` -> step:<step-id>`. If no transitions exist, the command prints
`No workflow transitions found`; if a source workflow filter has no matches, it
prints `No transitions found for workflow <workflow-id>`.

## workflow transition delete

Delete a transition between workflows.

```bash
vtb workflow transition delete <from-workflow-id> <to-workflow-id>
vtb workflow transition delete <from-workflow-id> <to-workflow-id> --json
```

Arguments and options:

| Argument/Option | Alias | Required | Notes |
| --- | --- | --- | --- |
| `<from-workflow-id>` | | Yes | Source workflow ID; accepts a case-insensitive full UUID or 8-character short ID. |
| `<to-workflow-id>` | | Yes | Target workflow ID; accepts a case-insensitive full UUID or 8-character short ID. |
| `--json` | | No | Global flag; returns a structured operation result with `command`, `status`, and resolved lowercased `from_workflow_id` and `to_workflow_id`. |
| `--help` | `-h` | No | Print help. |

The command has no command-specific flags, command aliases, defaults, or value
enums. Human-readable output prints
`Deleted transition from workflow <from-workflow-id> to workflow <to-workflow-id>`.
If no transition exists from the source workflow to the target workflow, the
workflow service returns a not-found error.

---

## Moving tasks between workflows

Use `vtb transition-to` (separate command) to move tasks:

```bash
vtb transition-to <task-id> <workflow>            # Move to workflow
vtb transition-to <task-id> <workflow>:<step>      # Move to specific step
```
