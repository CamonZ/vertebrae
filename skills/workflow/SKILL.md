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
| `workflow assign` | Assign a task to a workflow |
| `workflow unassign` | Remove workflow from a task |
| `workflow transition add` | Create a transition between workflows |
| `workflow transition list` | List workflow transitions |
| `workflow transition delete` | Delete a workflow transition |

---

## workflow add

Create a new workflow with steps.

```bash
# Basic workflow with steps
vtb workflow add "Code Review" --step review:sonnet --step approved:haiku

# With description
vtb workflow add "CI Pipeline" \
  -d "Automated build and test" \
  --step build:haiku \
  --step test:sonnet
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--description` | `-d` | Workflow description |
| `--step` | `-s` | Step in `name:model` format (repeatable) |
| `--order` | `-o` | Display order (default: 0) |

---

## workflow list

List all defined workflows.

```bash
vtb workflow list
```

---

## workflow show

Show detailed workflow information including steps.

```bash
vtb workflow show <workflow-id>
```

---

## workflow update

Update workflow properties.

```bash
vtb workflow update <id> --name "Development"
vtb workflow update <id> --description "New description"
vtb workflow update <id> --clear-description
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--name` | `-n` | New workflow name |
| `--description` | `-d` | New description |
| `--clear-description` | | Remove description |

---

## workflow delete

Delete a workflow. Cannot delete workflows with assigned tasks.

```bash
vtb workflow delete <workflow-id>
```

---

## workflow assign

Assign a task to a workflow (starts at first step).

```bash
vtb workflow assign <task-id> <workflow-id>
```

---

## workflow unassign

Remove workflow assignment from a task.

```bash
vtb workflow unassign <task-id>
```

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
```

## workflow transition delete

Delete a transition between workflows.

```bash
vtb workflow transition delete <from-workflow> <to-workflow>
```

---

## Moving tasks between workflows

Use `vtb transition-to` (separate command) to move tasks:

```bash
vtb transition-to <task-id> <workflow>            # Move to workflow
vtb transition-to <task-id> <workflow>:<step>      # Move to specific step
```
