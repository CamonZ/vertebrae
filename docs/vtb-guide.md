# Vertebrae (vtb) — CLI User Guide

Vertebrae (`vtb`) is a CLI client for the Sacrum GraphQL API. It provides structured workflows for planning, triaging, implementing, and reviewing work through a terminal interface.

> **Backend:** See [System Overview](system-overview.md) for how vtb fits into the broader Sacrum architecture.

## Configuration

Use `vtb init` to configure a project:

```bash
vtb init [OPTIONS]
```

The command has no positional arguments or aliases. It registers the current
directory as a Sacrum project, writes the client configuration, and copies the
embedded command skills into the project. See
[SACRUM_CONFIG.md](SACRUM_CONFIG.md) for the current config format and
environment overrides.

### Init Examples

```bash
# First-time setup when no token is already configured
vtb init --token <your-api-token>

# Use a non-default Sacrum API endpoint
vtb init --token <your-api-token> --url http://sacrum.example.com:4000

# Re-run safely after setup; existing config and project are reused
vtb init

# Copy embedded skills somewhere other than .claude/skills
vtb init --skills-target .custom/skills

# Machine-readable output
vtb init --json
```

### Init Options

| Flag | Description |
|------|-------------|
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `--url <URL>` | Sacrum API base URL; overrides the config file value and is saved when provided |
| `--token <TOKEN>` | Sacrum API token; overrides the config file value and is saved when provided |
| `--skills-target <SKILLS_TARGET>` | Target directory for embedded skills, relative to the current project unless an absolute path is provided (default: `.claude/skills`) |

`vtb init` derives the project slug from the current directory name, lowercases
it, and replaces spaces or special characters with hyphens. If no token is
provided and no token exists in the global config, the command fails before
contacting Sacrum and prints a hint to run `vtb init --token <your_token>`.
Sacrum API failures are reported as initialization errors while listing or
creating the project.

With `--json`, successful output is a JSON object containing `config_path`,
`project_slug`, `project_id`, `project_name`, `skills_copied`,
`skills_target`, and `project_created`. `skills_target` reports the resolved
directory used for the copy.

---

## CLI Manifest and Docs Validation

The shipped `vtb` binary can emit a machine-readable command manifest derived
from its clap definitions:

```bash
vtb manifest print
```

Validate command examples, aliases, and supported section types in this guide
and the command skills:

```bash
vtb manifest validate-docs --repo-root .
```

---

## Core Concepts

### Task Hierarchy

```
epic       → Large initiative spanning multiple features
  ticket   → Single deliverable feature
    task   → Unit of work (default level)
```

### Task Position: Workflow + Step

Tasks don't have a standalone status. A task's position is defined by its **workflow** and **step** within that workflow. For example, a task might be in the `implementation` workflow at the `coding` step.

Use `vtb transition-to` to move a task to a step in its current workflow:
```bash
vtb transition-to <id> <target>         # Move to a step by name, UUID, or short ID
```

Steps can be referenced by name (e.g., `backlog`, `in_progress`), full UUID,
or 8-character short ID. To move a task to a different workflow, use
`vtb workflow assign`.

### Short IDs

Anywhere `vtb` accepts a UUID (task, workflow, or step), you can pass an
**8-character short ID** — the first segment of the UUID. The CLI resolves it
to the full UUID before calling the backend.

```bash
vtb show c249947c                    # task short ID
vtb workflow show 9c20eacc           # workflow short ID
vtb step show ab12cd34               # step short ID (project-wide lookup)
vtb workflow assign c249947c 9c20eacc  # mixed short IDs
```

Resolution is entity-scoped: an unknown task prefix and an unknown workflow
prefix surface different errors (e.g. `workflow with prefix 'deadbeef' not
found`). Ambiguous prefixes list candidates; non-hex or over-length prefixes
report `invalid short ID`. Full UUIDs continue to work everywhere.

### Priorities

`low`, `medium`, `high`, `critical`

### JSON Output

Every command supports `--json` for machine-readable output:

```bash
vtb list --json                          # JSON array of tasks
vtb show <id> --json                     # JSON task object
vtb add "Title" --json                   # JSON of created task
```

---

## Creating Tasks

`vtb add` creates one task from a required `<TITLE>` positional argument:

```bash
vtb add [OPTIONS] <TITLE>
```

Quote titles that contain spaces. Unless `-l, --level` is provided, new items
are created at the `task` level. Omit `--workflow` to use the configured
default workflow.

### Basic Creation

```bash
# Simple task
vtb add "Task title"

# Ticket with level and description
vtb add "Feature title" -l ticket -d "Detailed description"

# Epic for a large initiative
vtb add "Refactor auth system" -l epic -d "Overhaul the authentication layer"

# Subtask under a parent
vtb add "Create sign() function" --parent <ticket-id>

# With priority and tags
vtb add "Fix login bug" -p critical -t bug -t backend

# With a dependency (this task is blocked by another)
vtb add "Write integration tests" --depends-on <blocker-id> --depends-on <another-blocker-id>

# Assign to a specific workflow on creation
vtb add "New feature" --workflow <workflow-id>

# Machine-readable output
vtb add "Task title" --json
```

### Add Options

| Flag | Description |
|------|-------------|
| `<TITLE>` | Required task title |
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-l, --level <LEVEL>` | Task level: `epic`, `ticket`, or `task` (default: `task`) |
| `-d, --description <DESCRIPTION>` | Detailed description |
| `-p, --priority <PRIORITY>` | Priority: `low`, `medium`, `high`, or `critical` |
| `-t, --tag <TAGS>` | Add a tag; repeat for multiple tags |
| `--parent <PARENT>` | Parent task ID; accepts a full UUID or 8-character short ID |
| `--depends-on <DEPENDS_ON>` | Blocker task ID; accepts a full UUID or 8-character short ID and can be repeated |
| `--workflow <WORKFLOW>` | Workflow ID to assign task to; accepts a full UUID or 8-character short ID |

For `vtb add`, `--json` returns an operation envelope with `command: "add"`,
`status: "created"`, and top-level `task_id` set to the created task ID. Clap rejects
invalid `--level` or `--priority` values, and it rejects malformed
`--parent`, `--depends-on`, or `--workflow` values before the command runs.
Unknown or ambiguous short IDs fail during ID resolution; missing referenced
tasks or workflows fail in the service layer.

### Planning a Feature (Epic -> Tickets -> Tasks)

```bash
# 1. Create the epic
vtb add "Implement market data streaming" -l epic -d "Real-time market data support"

# 2. Break into tickets
vtb add "Add MarketData request messages" -l ticket --parent <epic-id>
vtb add "Add MarketData response parsing" -l ticket --parent <epic-id>

# 3. Break tickets into tasks
vtb add "Create RequestData struct" --parent <ticket-id>
vtb add "Implement String.Chars for RequestData" --parent <ticket-id>

# 4. Set dependencies
vtb depend <string-chars-task> --on <struct-task>

# 5. View the plan
vtb show <epic-id>
vtb blockers <final-task-id>
```

---

## Documenting Tasks with Sections

Sections add structured content to tasks. They are critical for triage.

`vtb section` accepts the global `--json` flag and takes a case-insensitive task
ID, a section type, and non-empty content:

```bash
vtb section [--json] <id> <section-type> "content"
```

Single-instance section types replace the existing section of that type.
Multi-instance section types append a new section with a zero-based index.

### Section Types

| Type | Purpose | Cardinality |
|------|---------|-------------|
| `goal` | What this task achieves | Single |
| `context` | Background information | Single |
| `current_behavior` | How it works now (for bugs) | Single |
| `desired_behavior` | How it should work | Single |
| `checklist_item` | Trackable checklist with done/undone | Multiple |
| `constraint` | Requirements/limitations | Multiple |
| `testing_criterion` | How to verify success | Multiple |
| `anti_pattern` | What to avoid | Multiple |
| `failure_test` | Expected failure/edge cases | Multiple |

### Adding Sections

```bash
# Define the objective
vtb section <id> goal "Allow users to subscribe to real-time market data"

# Background context
vtb section <id> context "TWS provides tick-by-tick data via request ID subscriptions"

# Checklist items (trackable)
vtb section <id> checklist_item "Create RequestData struct with contract and tick_list fields"
vtb section <id> checklist_item "Implement binary serialization"
vtb section <id> checklist_item "Add response parsing in from_fields/1"
vtb section <id> checklist_item "Review API documentation"
vtb section <id> checklist_item "Update changelog"

# Constraints
vtb section <id> constraint "Must validate server version supports market data"
vtb section <id> constraint "All tests must use async: true"

# Testing criteria (at least 1 unit + 1 integration)
vtb section <id> testing_criterion "UNIT: RequestData.new/1 returns valid struct"
vtb section <id> testing_criterion "INTEGRATION: Full request/response cycle"

# Anti-patterns
vtb section <id> anti_pattern "Don't bypass Subscribable protocol with direct ETS writes"

# Failure tests
vtb section <id> failure_test "Invalid contract returns {:error, reason}"
```

### Viewing Sections

`vtb sections` lists the sections already attached to a task:

```bash
vtb sections [--json] [--type <SECTION_TYPE>] <id>
```

The command has one required positional argument, `<id>`, which is a
case-insensitive task ID. Without `--json`, output is grouped into desired and
undesired behavior using the section type categories above. Sections are sorted
by that group order, then by section type, then by their stored ordinal.

```bash
# List all sections
vtb sections <id>

# Filter by type
vtb sections <id> --type checklist_item
vtb sections <id> --type testing_criterion
vtb sections <id> --type constraint

# Emit machine-readable output
vtb sections <id> --type testing_criterion --json
```

`--type` accepts any value from the Section Types table above. Invalid section
types are rejected before the command runs and print the valid type list. With
`--json`, successful output contains `id`, `sections`, and `filter_type`;
`filter_type` is `null` when no filter was supplied.

### Editing and Removing Sections

```bash
# Edit a section in-place (type + 0-based index + new content)
vtb update <id> --edit-section checklist_item 0 "Updated checklist item"

# Remove a section (type + 0-based index)
vtb update <id> --remove-section checklist_item 0

# Remove single-instance types (no index needed)
vtb unsection <id> goal
vtb unsection <id> context

# Remove multi-instance types (index required)
vtb unsection <id> checklist_item --index 2
vtb unsection <id> testing_criterion --index 1

# Emit machine-readable output
vtb section <id> checklist_item "Update changelog" --json
```

### Checklist Items

Checklist items can be checked and unchecked to track progress:

```bash
# Mark checklist item #1 as done (1-based index)
vtb check-item <id> 1

# Uncheck item #2
vtb uncheck-item <id> 2

# Emit machine-readable output
vtb uncheck-item <id> 2 --json

# View checklist status via show
vtb show <id>
```

`vtb uncheck-item` accepts a case-insensitive task ID and a 1-based checklist
item index. The item must already be checked; otherwise the command fails with
`Validation failed: Checklist item <n> is not checked`.

Checklist items display with checkboxes:
```
Checklist Items:
  1. [x] Review API documentation
  2. [ ] Update changelog
```

---

## Triage: Making Tickets Ready for Work

Triage validates that a ticket is properly documented before it can be transitioned into an actionable workflow.

### Required Sections (blocks triage without them)

| Section | Minimum | Details |
|---------|---------|---------|
| `testing_criterion` | **2** | At least 1 unit + 1 integration criterion |
| `checklist_item` | **1** | Implementation steps |
| `constraint` | **2** | Architectural/quality guidelines |
| `goal` or `desired_behavior` | **1** | Clear objective |

### Strongly Encouraged (warns but allows with `--force`)

| Section | Minimum | Purpose |
|---------|---------|---------|
| `anti_pattern` | **1** | Pitfalls to avoid |
| `failure_test` | **1** | Error scenarios/edge cases |

### Recommended (informational only)

| Section | Purpose |
|---------|---------|
| `context` | Background information |
| `current_behavior` | Current state (for bugs/changes) |

### Triage Command

```bash
# Check what's missing
vtb show <id>

# Triage the ticket (validates sections)
vtb transition-to <id> <target-step>

# Force past warnings (not recommended)
vtb transition-to <id> <target-step> --force

# Escape hatch to bypass validation entirely
vtb transition-to <id> <target-step> --skip-validation

# Machine-readable output
vtb transition-to <id> <target-step> --json
```

---

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
vtb workflow delete <workflow-id>                  # Delete (no assigned tasks allowed)
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

### Assigning Workflows to Tasks

```bash
vtb workflow assign <task-id> <workflow-id>    # Assign (starts at first step)
vtb workflow unassign <task-id>                # Remove workflow
```

### Managing Steps

```bash
# Add a step to an existing workflow
vtb step add "Testing" -w <workflow-id> \
  --goal "Verify implementation" \
  --model sonnet \
  --order 1

# Add a final step (marks workflow complete when reached)
vtb step add "Approved" -w <workflow-id> --final

# Add step with transition restrictions
vtb step add "Needs Work" -w <workflow-id> --transition-to <step-id>

# Add step with prompt and agent config
vtb step add "Coding" -w <workflow-id> \
  --prompt "Implement the task described in {task.id}" \
  --agent-config '{"model":"opus","max_budget_usd":5.0}'

# Add step with agents and skills
vtb step add "Review" -w <workflow-id> \
  --agent .claude/agents/reviewer.md \
  --skill review \
  --skill simplify

# Add step with step type and output schema
vtb step add "Evaluate" -w <workflow-id> \
  --step-type evaluate \
  --output-schema '{"type":"object","required":["passed"],"properties":{"passed":{"type":"boolean"}}}'

# Add a human-input gate
vtb step add "Needs Input" -w <workflow-id> --step-type human_input

# Add a routing step
vtb step add "Router" -w <workflow-id> --step-type route

# Machine-readable creation result
vtb --json step add "Review" -w <workflow-id>

# List, show, update, delete steps
vtb step list <workflow-id>
vtb --json step list <workflow-id>
vtb step show <step-id>
vtb step update <step-id> --goal "New goal" --model opus
vtb step update <step-id> --prompt "New prompt for {task.id}"
vtb step update <step-id> --step-type evaluate
vtb step update <step-id> --output-schema '{"type":"object"}'
vtb step update <step-id> --clear-output-schema
vtb step update <step-id> --clear-agents --clear-skills
vtb --json step update <step-id> --final true
vtb step delete <step-id>
vtb step delete <step-id> --force
vtb --json step delete <step-id>
```

`vtb step add` takes a required `<name>` positional argument plus required
`--workflow` / `-w`; run `vtb step add --help` for the complete creation flag
list. `--transition-to` accepts full UUIDs or 8-character short IDs. The global
`--json` flag returns a creation envelope with `command`, `status`, `step_id`,
and `workflow_id`.

`vtb step list` takes exactly one required `<workflow>` argument and no
command-specific flags. `vtb step list --help` shows only the global `--json`
flag plus `-h` / `--help`. Human-readable output is ordered by each step's
`order` field and includes the step name, ID, type, model, and `[FINAL]` marker
when applicable:

```text
Steps for workflow '<workflow-id>':
1. coding (id: a1b2c3d4, type: execute, model: sonnet)
2. testing (id: e5f6a7b8, type: evaluate, model: haiku)
3. approved (id: c9d0e1f2, type: execute, model: default) [FINAL]
```

When the workflow has no steps, it prints `No steps found for workflow
'<workflow-id>'`. With the global `--json` flag, `step list` returns the raw
array of step objects and does not wrap the response in an `output` field.

`vtb step show` takes exactly one required `<id>` argument: the step ID to show.
It accepts a full UUID or an 8-character hex short ID and resolves IDs
case-insensitively. The command has no aliases, defaults, or value enums; its
help lists only `<ID>`, `--json`, and `-h` / `--help`.

Human-readable output is a flat detail view with the step ID and name, workflow
ID, order, step type, goal, agents, skills, model, output schema, final-step
marker, transitions, and created/updated timestamps:

```text
Step: 925c50ac-a1ed-4f5b-82c3-9dcb0773597b - implement
============================================================

Workflow:      84b28cbb-9c65-4d64-9ea0-b74587f9d056
Order:         1
Step Type:     execute
Goal:          Implement the ticket in the assigned worktree.
Agents:        (none)
Skills:        (none)
Model:         gpt-5.5
Output Schema: (none)
Is Final:      No
Transitions:   57d373b1-e40d-4a42-9ae4-1c6461d7a2b9
Created:       2026-05-29 12:53
Updated:       2026-05-30 16:48
```

Missing optional fields are shown as `(none)`, and missing timestamps are shown
as `-`. If a full UUID reaches `step show` but no matching step exists, the
command fails with `Step not found: <id>`. If an 8-character hex short ID cannot
be resolved, the shared ID resolver reports `step with prefix '<id>' not found`.

With the global `--json` flag, `step show` returns the raw `Step` object and
does not wrap the response in an `output` field:

```bash
vtb --json step show <step-id>
```

The JSON object includes fields such as `id`, `name`, `workflow_id`, `order`,
`goal`, `prompt`, `agents`, `skills`, `step_type`, `agent_config`,
`output_schema`, `is_final`, `transitions_to`, `created_at`, and `updated_at`.

`vtb step update` takes exactly one required `<id>` argument: the step ID to
update. It accepts a full UUID or an 8-character hex short ID and resolves IDs
case-insensitively. Every command-specific flag is optional, so running
`vtb step update <step-id>` with no property flags is accepted and performs a
request with no property changes before reporting success.

| Flag | Short | Behavior |
|------|-------|----------|
| `--name <NAME>` | | Replace the step name |
| `--goal <GOAL>` | `-g` | Replace the step goal |
| `--agent <AGENT>` | `-a` | Replace the full agents list; repeat for multiple agents |
| `--clear-agents` | | Replace the agents list with an empty list |
| `--skill <SKILL>` | `-s` | Replace the full skills list; repeat for multiple skills |
| `--clear-skills` | | Replace the skills list with an empty list |
| `--prompt <PROMPT>` | | Replace the execution prompt |
| `--agent-config <JSON>` | | Replace/overlay the full agent config from a JSON string |
| `--model <MODEL>` | `-m` | Set `agent_config.model` |
| `--provider <PROVIDER>` | | Set `agent_config.provider`; accepts `anthropic`/`claude` or `openai`/`codex`; alias `--model-provider` |
| `--codex-model-provider <PROVIDER>` | | Set `agent_config.codex_model_provider`; alias `--codex-provider`; only valid when the resulting provider is OpenAI/Codex |
| `--reasoning-effort <EFFORT>` | | Set `agent_config.reasoning_effort`; valid values are `low`, `medium`, `high`, and `xhigh`; only valid when the resulting provider is OpenAI/Codex |
| `--step-type <STEP_TYPE>` | | Set the step type; values are `execute`, `evaluate`, `route`, `wait_children`, and `human_input` |
| `--output-schema <JSON>` | | Replace the step output schema from a JSON string |
| `--clear-output-schema` | | Remove the output schema |
| `--order <ORDER>` | `-o` | Replace the 0-indexed step order |
| `--final <true|false>` | | Set or unset the final-step marker |
| `--transition-to <STEP_ID>` | `-t` | Replace the full transitions list; repeat for multiple target steps |
| `--clear-transitions` | | Replace the transitions list with an empty list |

For replacement-list fields, update is not additive: any provided `--agent`,
`--skill`, or `--transition-to` values replace the existing list. The matching
`--clear-*` flags win for that field when present. `--agent-config` starts from
the supplied JSON; the shortcut flags (`--provider`, `--model`,
`--codex-model-provider`, and `--reasoning-effort`) then overlay individual
fields before the config is validated and persisted.

Invalid JSON in `--agent-config` or `--output-schema` fails before persistence.
Provider/model mismatches, Codex upstream provider usage when the resulting
provider is Anthropic, and Anthropic reasoning effort are rejected by the CLI
before the step is updated.
If a full UUID reaches `step update` but no matching step exists, the command
fails with `Step not found: <id>`. If an 8-character hex short ID cannot be
resolved, the shared ID resolver reports `step with prefix '<id>' not found`.

Human-readable success output is:

```text
Updated step: <step-id>
```

With the global `--json` flag, `step update` returns an operation envelope:

```json
{
  "command": "step update",
  "status": "updated",
  "step_id": "<step-id>"
}
```

`vtb step delete` takes exactly one required `<id>` argument: the step ID to
delete. It accepts a full UUID or an 8-character hex short ID and resolves IDs
case-insensitively. Its only command-specific flag is `--force` / `-f`.
Deletion does not prompt for confirmation today, so `--force` is accepted for
compatibility with delete-style commands rather than changing behavior.

Human-readable success output is:

```text
Deleted step: <step-id>
```

With the global `--json` flag, `step delete` returns an operation envelope:

```json
{
  "command": "step delete",
  "status": "deleted",
  "step_id": "<step-id>"
}
```

The JSON `step_id` is lowercased. If a full UUID reaches `step delete` but no
matching step exists, the command fails with `Step not found: <id>`. If an
8-character hex short ID cannot be resolved, the shared ID resolver reports
`step with prefix '<id>' not found`.

### Step Properties

| Property | Description |
|----------|-------------|
| `name` | Step name (e.g., "backlog", "coding", "review") |
| `order` | Execution order (lower = first, 0-indexed) |
| `final` | Marks workflow as complete when reached |
| `goal` | What this step accomplishes |
| `prompt` | Template sent to the executing agent (supports `{task.id}` interpolation) |
| `model` | AI model shortcut (sonnet, haiku, opus) |
| `agent-config` | Full LLM config JSON (model, budget, tools, permissions) |
| `provider` | Built-in execution provider shortcut (`anthropic`/`claude` or `openai`/`codex`); `--model-provider` is an alias |
| `codex-model-provider` | Codex upstream provider shortcut from `~/.codex/config.toml`; `--codex-provider` is an alias |
| `reasoning-effort` | OpenAI/Codex reasoning effort (`low`, `medium`, `high`, `xhigh`) |
| `agents` | Agent file paths for AI-assisted execution |
| `skills` | Slash commands available during this step |
| `transition-to` | Restrict which steps can follow this one |
| `step-type` | Type of step: `execute`, `evaluate`, `route`, `wait_children`, or `human_input` (see below) |
| `output-schema` | JSON Schema for structured output enforcement (see below) |

### Step Types

Each step has a `--step-type` that determines its role in the workflow:

| Type | Description |
|------|-------------|
| `execute` | **Default.** Runs the step's prompt via Claude and produces output. |
| `evaluate` | Assesses the output of a previous step. Used with `eval_prompt` to determine which transition to follow when a step has multiple outgoing paths. |
| `route` | Directs work to different paths based on conditions. Uses a fixed routing contract schema. |
| `wait_children` | Parent/child orchestration barrier — pauses the parent until all child tasks complete. Handled server-side by Sacrum; the daemon does not execute this step type directly. |
| `human_input` | Human review/input gate. The workflow pauses for external input instead of dispatching a daemon execution. |

```bash
# Set step type on creation
vtb step add "Eval" -w <wf-id> --step-type evaluate

# Create a human-input gate
vtb step add "Needs Input" -w <wf-id> --step-type human_input

# Change step type later
vtb step update <step-id> --step-type route
```

When a step has type `evaluate` and multiple outgoing transitions, the daemon runs a separate evaluation execution whose output is matched against transition labels to determine the next step — creating a **branching state machine** driven by AI judgment.

### Output Schemas

Steps can define an `output_schema` — a JSON Schema describing the expected structured output from the selected harness. When present:

- The daemon passes it to the selected harness subprocess, enforcing structured output
- The step-level `output_schema` takes precedence over `agent_config.json_schema`
- This enables reliable machine-readable responses for evaluation steps, routing decisions, and automated pipeline stages

```bash
# Set output schema on creation
vtb step add "Eval" -w <wf-id> --step-type evaluate \
  --output-schema '{"type":"object","required":["summary","passed"],"properties":{"summary":{"type":"string"},"passed":{"type":"boolean"}}}'

# Update output schema
vtb step update <step-id> --output-schema '{"type":"object"}'

# Clear output schema
vtb step update <step-id> --clear-output-schema
```

### Provider Selection (Anthropic / OpenAI)

Each step picks the harness (the local CLI) that will run its prompt via
`agent_config.provider`. The MVP ships with two built-in providers:

| Provider | Harness CLI | Binary | Stream parser | Provider-binary lookup env var |
|----------|-------------|--------|---------------|--------------------------------|
| `anthropic` (default) | Claude Code | `claude` | `--output-format stream-json` JSONL | `CLAUDE_CODE_PATH` |
| `openai` | Codex CLI | `codex` | `codex exec --json` JSONL | `CODEX_PATH` |

When `provider` is unset on a step, the daemon defaults to **Anthropic** to
preserve pre-refactor behavior. The daemon resolves the harness binary by
checking the provider-specific env var first, then the user's login-shell
`PATH`, then well-known install locations (`~/.local/bin`, `/usr/local/bin`,
`/opt/homebrew/bin`).

> **Authentication is the harness's job, not Vertebrae's.** The daemon does not
> read `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or any other vendor credential
> directly. Each provider authenticates through its own CLI's existing
> mechanism — typically `claude login` for Claude Code and `codex login` (or
> the equivalent vendor env var the harness itself reads) for Codex. Run the
> harness once interactively, confirm it works standalone, then point
> Vertebrae at it.

#### Setting the provider on a step

`vtb step add` and `vtb step update` accept `--provider` (alias:
`--model-provider`), `--model`, `--codex-model-provider` (alias:
`--codex-provider`), and `--reasoning-effort` as convenience shortcuts that
overlay the step's `agent_config`:

```bash
# Default behavior — provider unset, daemon uses Anthropic / Claude Code
vtb step add "Coding" -w <wf-id> --model sonnet

# Explicit Anthropic with a Claude model
vtb step add "Coding" -w <wf-id> \
  --provider anthropic \
  --model claude-sonnet-4-20250514

# OpenAI / Codex with a GPT model (alias --model-provider also works)
vtb step add "Coding" -w <wf-id> \
  --model-provider openai \
  --model gpt-5.5 \
  --reasoning-effort high

# Codex harness with an OpenRouter upstream provider configured in ~/.codex/config.toml
vtb step add "Coding" -w <wf-id> \
  --provider openai \
  --codex-model-provider openrouter \
  --model deepseek/deepseek-v4-flash

# Codex harness with a Z.ai upstream provider configured in ~/.codex/config.toml
vtb step add "Coding" -w <wf-id> \
  --provider openai \
  --codex-provider zai \
  --model glm-5.1

# Switch an existing step over to Codex
vtb step update <step-id> --provider openai --model o3-mini --reasoning-effort high

# Drop back to Anthropic
vtb step update <step-id> --provider anthropic --model opus
```

Accepted provider names (case-insensitive): `anthropic` / `claude`,
`openai` / `codex`.

For Codex steps, `provider=openai` selects the local Codex harness. It does not
necessarily mean the upstream model API is OpenAI. Set
`codex_model_provider` with `--codex-model-provider` when Codex should use a
custom upstream provider from `~/.codex/config.toml`; Vertebrae passes it as
`codex exec -c model_provider="<value>" ...`. Keep API keys and bearer tokens
in Codex config or environment, not in Vertebrae task data.

Reasoning effort is OpenAI/Codex-only. Valid values are `low`, `medium`,
`high`, and `xhigh`; unsupported values such as `minimal` are rejected. A step
with `--provider anthropic` / Claude plus `--reasoning-effort` is rejected
before persistence or execution.

#### Recognized model aliases

The CLI validates the `(provider, model)` pair against a small built-in
catalog before persisting the step:

- **Anthropic:** the bare aliases `opus`, `sonnet`, `haiku`, plus any
  `claude-*` / `claude` model name.
- **OpenAI:** any `gpt-*` / `gpt` model, the reasoning aliases `o<digit>...`
  (e.g. `o1`, `o1-mini`, `o3`, `o3-mini`, `o4-mini`), and `codex-*` / `codex`.

Mismatched pairs (e.g. `--provider openai --model claude-opus-4-5`) are
rejected at the CLI with an actionable error. Unknown model names are also
rejected unless `--provider openai` is paired with `--codex-model-provider`,
which tells Vertebrae to leave provider-scoped model IDs such as
`deepseek/deepseek-v4-flash` or `glm-5.1` to Codex. `codex_model_provider` is
rejected with `--provider anthropic` because Claude Code does not understand
Codex upstream provider profiles. `--agent-config` is still useful when you
need to set provider/model together with lower-level config fields:

```bash
vtb step update <step-id> \
  --agent-config '{"provider":"openai","codex_model_provider":"openrouter","model":"deepseek/deepseek-v4-flash","reasoning_effort":"high","max_budget_usd":5.0}'
```

#### Local smoke test

The end-to-end smoke path exercises both providers. It assumes the daemon is
installed (`vtb daemon install`) and the relevant harness CLI is logged in.

```bash
# 0. Confirm the harnesses Vertebrae will spawn are reachable.
which claude   # or set CLAUDE_CODE_PATH
which codex    # or set CODEX_PATH
claude --version
codex --version

# 1. Anthropic / Claude default behavior.
#    Provider is unset on the step, so the daemon picks Anthropic and runs `claude`.
vtb workflow add "Smoke-Claude" --step Hello:sonnet
vtb add "Smoke: Claude default" -d "say hi"
vtb workflow assign <task-id> <smoke-claude-wf-id>
vtb run <task-id>
vtb execution list <task-id>          # confirm a run was recorded

# 2. OpenAI / Codex provider selection.
#    Separate workflow whose single step targets Codex/gpt-5.5.
vtb workflow add "Smoke-Codex"
vtb step add "Hello" -w <smoke-codex-wf-id> \
  --provider openai \
  --model gpt-5.5 \
  --reasoning-effort high \
  --prompt "Reply with the single word: ok"
vtb add "Smoke: Codex" -d "say hi"
vtb workflow assign <task-id-2> <smoke-codex-wf-id>
vtb run <task-id-2>
vtb execution list <task-id-2>        # confirm a run was recorded
```

Each smoke task uses a single-step workflow so the run is unambiguous about
which provider the daemon resolved. The resolved provider and model are
persisted on the `StepExecution` record (and reported back to the backend); the
`vtb execution show` text output does not yet print those fields, so confirm
the harness was actually used by tailing the daemon logs or by inspecting the
spawned process while the run is in flight.

#### Out of scope for the MVP

The current tranche is intentionally CLI-driven. The following are **not**
supported and should not be assumed to work:

- **GUI profile editing.** Provider/model selection is set via `vtb step
  add` / `vtb step update` only. The GUI does not yet expose a profile editor.
- **Remote or durable workers.** The daemon runs locally and spawns local
  harness binaries. Remote daemon routing, durable worker registration, and
  claim/lease assignment are not implemented.
- **Arbitrary harness profiles.** Only the two built-in providers
  (`anthropic`, `openai`) are recognized. User-owned harness profile
  registries and arbitrary binary profiles are deferred.
- **Storing secrets in Sacrum.** API keys, login tokens, and other vendor
  credentials must remain with the harness CLI on the local machine. Sacrum
  does not store, proxy, or distribute provider secrets.

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
vtb workflow transition delete <from-workflow> <to-workflow>
```

`workflow transition add` takes two required positional arguments:
`<from-workflow-id>` and `<to-workflow-id>`. Both workflow IDs accept a
case-insensitive full UUID or 8-character short ID. The optional `--target-step`
value accepts a full UUID or an 8-character short ID.
`--label` (`-l`) is required. `--target-step` (`-t`) is optional and selects the
destination workflow step where tasks should land after the transition. The
global `--json` flag can appear anywhere in the command and returns the created
workflow transition object instead of human-readable text.

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

## Marking Checklist Items Done

Track progress with checklist items:

```bash
# Mark checklist item 1 as done (1-based index)
vtb check-item <task-id> 1

# Mark checklist item 1 as not done
vtb uncheck-item <task-id> 1

# View checklist completion status
vtb show <task-id>
```

Checklist item indices are 1-based. See [Checklist Items](#checklist-items)
for `uncheck-item` JSON output and validation behavior.

Checklist items display with checkboxes:
```
Checklist Items:
  1. [x] Create database schema
  2. [ ] Implement API endpoint
```
  3. [ ] Write tests
```

---

## Dependencies

### Creating Dependencies

```bash
# Task A depends on task B (B must finish before A can start)
vtb depend <task-a> --on <task-b>

# Short IDs are accepted anywhere a task ID is accepted
vtb depend <task-a-short-id> --on <task-b-short-id>

# Machine-readable output
vtb depend <task-a> --on <task-b> --json
```

### Depend Options

```bash
vtb depend [OPTIONS] --on <BLOCKER_ID> <ID>
```

| Flag | Description |
|------|-------------|
| `<ID>` | Required task ID to block; accepts a full UUID or 8-character short ID, case-insensitive |
| `--on <BLOCKER_ID>` | Required blocker task ID; accepts a full UUID or 8-character short ID, case-insensitive |
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-h, --help` | Print command help |

`vtb depend` has no aliases, no short flags, and no defaults. Under `--json`,
the command returns `task_id`, `blocker_id`, and `already_existed`.

Adding the same dependency again is idempotent: the command succeeds and reports
that the dependency already exists. The command rejects malformed IDs before
execution, unknown or ambiguous short IDs during ID resolution, missing tasks in
the service layer, self-dependencies, and dependencies that would create a
cycle.

### Removing Dependencies

```bash
# Task A no longer depends on task B
vtb undepend <task-a> --on <task-b>

# Short IDs are accepted anywhere a task ID is accepted
vtb undepend <task-a-short-id> --on <task-b-short-id>

# Machine-readable output
vtb undepend <task-a> --on <task-b> --json
```

### Undepend Options

```bash
vtb undepend [OPTIONS] --on <BLOCKER_ID> <ID>
```

| Flag | Description |
|------|-------------|
| `<ID>` | Required task ID to remove the dependency from; accepts a full UUID or 8-character short ID, case-insensitive |
| `--on <BLOCKER_ID>` | Required blocker task ID to remove; accepts a full UUID or 8-character short ID, case-insensitive |
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-h, --help` | Print command help |

`vtb undepend` has no aliases, no short flags, and no defaults. Under `--json`,
the command returns `task_id`, `blocker_id`, and `existed`.

Removing an existing dependency succeeds and reports that the task no longer
depends on the blocker. Removing a dependency that is not present also succeeds
and reports a warning in human-readable output, with `existed: false` under
`--json`. The command rejects malformed IDs before execution and unknown or
ambiguous short IDs during ID resolution. The source task must exist. A
non-existent full UUID blocker can still report `existed: false` when the source
task does not depend on it; service failures while removing an existing
dependency are reported as errors.

### Viewing Dependencies

```bash
# Full blocker tree for a task
vtb blockers <task-id>
vtb blockers <task-id> --depth 2        # Limit depth
vtb blockers <task-id> --all            # Include blockers in the done workflow step
vtb blockers <task-id> --json           # Emit task_id, task_title, blockers, total_count

# Shortest path between two tasks
vtb path <from-task> <to-task>
vtb path <from-task> <to-task> --json
```

`vtb blockers` hides blockers whose current workflow step is `done` unless
`--all` is passed. The `--depth` flag is unlimited by default and accepts a
non-negative integer depth.

### Path Options

```bash
vtb path [OPTIONS] <FROM_ID> <TO_ID>
```

| Flag | Description |
|------|-------------|
| `<FROM_ID>` | Required source task ID; accepts a full UUID or 8-character short ID, case-insensitive |
| `<TO_ID>` | Required target task ID; accepts a full UUID or 8-character short ID, case-insensitive |
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-h, --help` | Print command help |

`vtb path` has no aliases, no command-specific flags, and no defaults. It
traverses `depends_on` edges with breadth-first search and returns the shortest
path from source to target. If both arguments refer to the same task, human
output is `Same task: <id> "<title>"`. If no path exists, the command prints
`No dependency path from <from_id> to <to_id>` and still exits successfully.
Under `--json`, the command returns `from_id`, `to_id`, and `path`; `path` is
`null` when no path exists, otherwise it is an ordered array of task summaries
with `id` and `title`.

Malformed IDs are rejected by CLI parsing. Unknown or ambiguous 8-character
short IDs fail during ID resolution. Both resolved tasks must exist before path
search runs.

---

## Code References

Link tasks to specific code locations:

```bash
# File reference
vtb ref <id> "src/service.rs"

# Specific line
vtb ref <id> "src/service.rs:L42"

# Line range with name
vtb ref <id> "src/service.rs:L42-60" --name "process_request" --desc "Main dispatch"

# Link test to testing criterion (1-based criterion index)
vtb criterion-ref <id> 1 "tests/service_test.rs:L10-25" \
  --name "test_process_request"
vtb criterion-ref <id> 1 "tests/service_test.rs:L10-25" \
  --description "Covers request processing"
vtb criterion-ref <id> 1 "tests/service_test.rs:L10-25" --json

# View and remove references
vtb refs <id>
vtb unref <id> "src/service.rs"
vtb unref <id> --all
```

For `vtb criterion-ref`, the criterion index is 1-based among the task's
`testing_criterion` sections. File specs use the same syntax as `vtb ref`;
reversed ranges, empty paths, and missing line numbers after `:L` are validation
errors. `--description` also has the visible alias `--desc`. Missing files are
accepted with a warning so tests can be linked before the file is created. With
`--json`, the command returns an operation envelope with `command`
(`criterion-ref`), `status` (`created`), `task_id`, `criterion_index`,
`criterion_content`, `path`, `line_start`, `line_end`, `name`, and `warning`.

---

## Querying Tasks

### Listing

```bash
vtb list                              # All non-archived tasks (tree view)
vtb list --json                       # JSON array of task summaries
vtb list --flat                       # Flat table view
vtb list --status in_progress         # By workflow step name (repeatable)
vtb list -s todo -s in_progress       # Short alias for repeated status filters
vtb list --workflow <workflow-id>     # By workflow UUID or 8-char short ID
vtb list --step <step-id>             # By current step UUID or 8-char short ID
vtb list -w <wf-id> --step <step-id>  # Combine workflow and step filters
vtb list --level ticket               # By level (can repeat: -l epic -l ticket)
vtb list --priority high              # By priority (can repeat)
vtb list --tag backend                # By tag (can repeat)
vtb list --parent <id>                # Children of a specific parent UUID or short ID
vtb list --root                       # Only root items (no parent)
vtb list --search "auth"              # Search title/description (case-insensitive)
vtb list --include-archived           # Include archived items
```

`vtb list` accepts `--json` either before or after the subcommand. JSON output
is a task summary array with `id`, `title`, `level`, `workflow_name`,
`step_name`, run-state fields, `priority`, `tags`, `archived`, and `parent_id`.

The `--level` values are `epic`, `ticket`, and `task`; `--priority` values are
`low`, `medium`, `high`, and `critical`. Invalid enum values are rejected by
clap before execution. `--workflow`, `--step`, and `--parent` accept full UUIDs
or 8-character hex short IDs, and short IDs are resolved before the query runs.
`--search ""` or whitespace-only search text fails with
`Validation failed: Search query cannot be empty`.

`--status` filters by the task's current workflow step name, not a separate
global task status field. Available values depend on configured workflow steps.

### Viewing Details

```bash
vtb show <id>                         # Full task details with sections, refs, relationships
vtb --json show <id>                  # Same details as a JSON task object
vtb show <id> --json                  # Global --json may also appear after the subcommand
```

`<id>` is required and accepts a full task UUID or an 8-character hex short ID.
The lookup is case-insensitive after ID validation. `vtb show` has no
task-specific filters; use `vtb list` or `vtb ready` to find candidate tasks
before opening one detail view.

The human-readable view prints task metadata, workflow position and
previous/next steps, run state and controls, recent task-local run history,
description, structured sections, relationships, and code references.
Checklist items are rendered with checkboxes, and testing criteria show linked
code refs inline. Completed blockers are omitted from the `Blocked by` list,
while children and downstream `Blocks` relationships are shown as summaries.

Under `--json`, the command returns the structured task detail object directly,
including `workflow`, `run_controls`, `run_history`, `sections`, `code_refs`,
`parent`, `children`, `blocked_by`, `blocks`, `archived`, and `parent_id`.

### Finding Actionable Work

```bash
vtb ready                             # Items ready for work or triage
vtb --json ready                      # Same command as machine-readable JSON
vtb ready --json                      # Global --json may also appear after the subcommand
```

`vtb ready` has no positional arguments or command-specific flags. It returns
actionable items from the backend ready query, filters archived items out of
that result, and prints each remaining item as `id`, `level`, and `title` under
`Ready to start (backlog):`. If no items are ready, it prints
`No actionable items found.`.

JSON output is an object with a `backlog_ready` array containing the serialized
task records returned by the command.

---

## Updating Tasks

```bash
vtb update <id> --title "New title"
vtb update <id> --description "New description"
vtb update <id> -d ""                            # Clear description
vtb update <id> --priority high
vtb update <id> --add-tag urgent --add-tag backend
vtb update <id> --remove-tag old-tag
vtb update <id> --parent <parent-id>
vtb update <id> --parent ""                      # Remove parent
vtb update <id> --worktree /path/to/worktree
vtb update <id> --worktree ""                    # Clear worktree
vtb update <id> --edit-section checklist_item 0 "New content"
vtb update <id> --remove-section checklist_item 0
```

**Never use `vtb update` for workflow/step changes** — use `vtb transition-to` instead.

---

## Deleting and Archiving Tasks

```bash
# Delete a single task; prompts for confirmation
vtb delete <id>

# Delete a task and all descendants
vtb delete <id> --cascade

# Delete without prompts; children are orphaned unless --cascade is also set
vtb delete <id> --force

# Machine-readable delete result
vtb delete <id> --force --json

# Soft-delete via archive.
# <id> accepts a full UUID or 8-character short ID.
vtb archive <id>

# Restore an archived task.
# <id> accepts a full UUID or 8-character short ID.
vtb unarchive <id>
```

Archived tasks are excluded from `vtb list` by default. Use `--include-archived` to see them.

### Delete Options

```bash
vtb delete [OPTIONS] <ID>
```

| Flag | Description |
|------|-------------|
| `<ID>` | Required task ID; accepts a full UUID or 8-character short ID, case-insensitive |
| `--cascade` | Also delete all children recursively |
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-f, --force` | Skip confirmation prompts |
| `-h, --help` | Print command help |

`vtb delete` has no aliases. Without `--force`, a task with no children prompts
`Delete task '<title>'? [y/N]`; only `y` or `yes` confirms. A task with children
prompts `[C]ascade delete / [O]rphan / [A]bort?`; `c`/`cascade` deletes the
subtree, `o`/`orphan` deletes only the selected task and keeps children, and
`a`/`abort`, an empty response, or an unrecognized response cancels. If the task
blocks other tasks, the command also prompts for confirmation unless `--force`
is passed.

With `--force` but without `--cascade`, children are orphaned. Dependencies
pointing to deleted tasks are removed by the service. Under `--json`, the
operation envelope includes `command`, `status`, `task_id`, `cascade`,
`deleted`, and `deleted_count`; `status` is either `deleted` or `cancelled`.
Clap rejects missing or malformed IDs before the command runs; unknown or
ambiguous short IDs fail during ID resolution, and missing tasks fail in the
service layer.

### Archive and Unarchive Options

```bash
vtb archive [OPTIONS] <ID>
vtb unarchive [OPTIONS] <ID>
```

| Flag | Description |
|------|-------------|
| `<ID>` | Required task ID; accepts a full UUID or 8-character short ID, case-insensitive |
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-h, --help` | Print command help |

These commands have no aliases or command-specific flags. `vtb archive` sets
`archived=true`; `vtb unarchive` sets `archived=false`. Under `--json`, each
returns an operation envelope with `command` set to `archive` or `unarchive`,
`status: "updated"`, and `data.archived` set to the resulting boolean value.
Clap rejects missing or malformed IDs before the command runs; unknown or
ambiguous short IDs fail during ID resolution, and missing tasks fail in the
service layer.

---

## Daemon Management

The daemon (`vtb-daemon`) is a background service that executes workflow steps by spawning a local harness CLI — Claude Code (`claude`) for `anthropic` provider steps and Codex CLI (`codex`) for `openai` provider steps. See [Provider Selection](#provider-selection-anthropic--openai) for how to pick a harness per step. It runs as a macOS launchd service or a Linux systemd `--user` service.

```bash
# Install as a launchd or systemd user service
vtb daemon install

# Install with explicit binary path
vtb daemon install --binary /usr/local/bin/vtb-daemon

# Check daemon status
vtb daemon status

# Uninstall the service
vtb daemon uninstall
```

### Daemon Install Options

```bash
vtb daemon install [OPTIONS]
```

| Flag | Description |
|------|-------------|
| `--binary <BINARY>` | Explicit path to the `vtb-daemon` binary; if omitted, the CLI resolves `vtb-daemon` from `PATH` with `which` |
| `--json` | Appears in generated help but is currently ignored for daemon commands; output remains human-readable |
| `-h, --help` | Print command help |

`vtb daemon install` has no aliases, positional arguments, short flags,
defaults, or value enums. If `--binary` is provided, the path must exist and is
canonicalized before installation. Without `--binary`, `vtb-daemon` must be on
`PATH`; otherwise the command fails with a hint to install it or pass
`--binary`. On macOS, installation writes
`~/Library/LaunchAgents/com.vertebrae.daemon.plist`, loads it with
`launchctl`, and logs to `~/Library/Logs/vertebrae/{daemon.log,daemon.error.log}`.
On Linux, installation writes
`~/.config/systemd/user/vertebrae-daemon.service`, runs `systemctl --user
daemon-reload`, enables and starts `vertebrae-daemon`, and logs to
`~/.local/state/vertebrae/logs/{daemon.log,daemon.error.log}`.

### Daemon Uninstall Options

```bash
vtb daemon uninstall [OPTIONS]
```

| Flag | Description |
|------|-------------|
| `--json` | Appears in generated help but is currently ignored for daemon commands; output remains human-readable |
| `-h, --help` | Print command help |

`vtb daemon uninstall` has no aliases, positional arguments, command-specific
flags, short flags, defaults, or value enums. On macOS, it checks for
`~/Library/LaunchAgents/com.vertebrae.daemon.plist`; on Linux, it checks for
`~/.config/systemd/user/vertebrae-daemon.service`. If no service file exists,
the command is a no-op and reports that `vtb-daemon` is not installed.

When installed, the command unregisters the user service through the platform
service manager and removes the service file. On success, it reports the
removed plist or systemd unit path and notes that the daemon will no longer
start on login. Service-manager or filesystem failures are surfaced as command
errors from the shared installer layer.

### Running Steps via Daemon

Once the daemon is running, trigger step execution:

```bash
# Run the current step for a task (dispatches to daemon)
vtb run <task-id>

# Emit the StepExecution as machine-readable JSON
vtb --json run <task-id>

# Start a TaskRun for a task's assigned workflow (automatic multi-step)
vtb start-taskrun <task-id>

# Compatibility alias
vtb run-workflow <task-id>

# Stop the active TaskRun for a task
vtb stop-taskrun <task-id>

# Emit the stopped TaskRun (or null when none is active) as JSON
vtb --json stop-taskrun <task-id>

# Compatibility alias
vtb stop <task-id>

# Compatibility alias
vtb stop-workflow <task-id>
```

`vtb run` executes exactly the task's current workflow step and returns a
`StepExecution` record. It has no command alias. The only required input is
`<task-id>`; use the global `--json` flag for machine-readable output. The task
must already have an assigned workflow and current step, and a connected daemon
must be available to handle the execution. `vtb start-taskrun` starts a durable
TaskRun for the task's assigned workflow, handling transitions, eval prompts,
and workflow chaining. `vtb stop-taskrun` stops the active TaskRun for the task
ID passed as its only positional argument. It accepts the global `--json` flag:
JSON output is the stopped `TaskRun` object, or `null` when the task has no
active TaskRun. Human-readable output reports either `Stopped run: <status>
taskRun=<task-run-id> latestStep=<step-execution-id|none>` or `No active run for
task <task-id>`. `vtb run-workflow`, `vtb stop`, and
`vtb stop-workflow` remain compatibility aliases for `start-taskrun` and
`stop-taskrun`.

---

## Execution Tracking

Record and review workflow execution history:

```bash
# Create a new execution record
vtb execution create <task-id>
vtb execution create <task-id> --context '{"files":["src/lib.rs"]}' --prompt '{"instructions":"Review changes"}'

# Add log entries
vtb execution log <execution-id> "Processing..."
vtb execution log <execution-id> $'Line 1\nLine 2'
vtb execution log <execution-id> "Processing..." --json

# Update execution output/result
vtb execution update <execution-id> --output "Completed"

# View execution lists/details
vtb execution list <task-id>
vtb execution list --task-run <task-run-id>
vtb execution show <execution-id>
```

`vtb execution create <task-id>` creates a `StepExecution` for the task's
current workflow step. The task ID accepts a full UUID or an 8-character hex
task short ID. The task must exist, have a workflow assigned, and have a
current step. `--context` and `--prompt` accept any JSON object; invalid JSON
fails validation before the execution is created. With `--json`, the command
returns a machine-readable create result with `command: "execution create"`,
`status: "created"`, `execution_id`, and the resolved lowercase `task_id`.

`vtb execution list <task-id>` treats the positional ID as a task ID. Task short
IDs are supported, and the output groups TaskRun-backed step executions by
`taskRunId`. Use `vtb execution list --task-run <task-run-id>` to list only the
executions for one exact TaskRun. TaskRun mode requires a full UUID; TaskRun
short IDs are not supported. `execution list` stays compact and does not render
TaskRun trees or session log content; use `execution show <execution-id>` for
the detailed log/output view.

`vtb execution log <execution-id> <content>` adds one session log entry to an
existing step execution. The execution ID must be a full UUID; short execution
IDs are rejected by CLI parsing. The required content argument may include
newlines; quote it in your shell when needed. The command does not read content
from stdin. The command fails before creating a log if the execution does not
exist. Human output prints the short log ID, short execution ID, and a content
preview; long previews are truncated to 50 characters and multiline previews
are flattened to spaces. With `--json`, the command returns
`command: "execution log"`, `status: "created"`, `execution_id`, and `log_id`.

---

## Typical Workflow (End to End)

```bash
# 1. Plan
vtb add "Implement TickByTick support" -l epic -d "Real-time tick data"
vtb add "Add request messages" -l ticket --parent <epic-id>
vtb add "Add response parsing" -l ticket --parent <epic-id>

# 2. Document and triage tickets
vtb section <ticket-id> goal "..."
vtb section <ticket-id> checklist_item "..."
vtb section <ticket-id> testing_criterion "UNIT: ..."
vtb section <ticket-id> testing_criterion "INTEGRATION: ..."
vtb section <ticket-id> constraint "..."
vtb section <ticket-id> constraint "..."
vtb section <ticket-id> checklist_item "Update documentation"
vtb section <ticket-id> checklist_item "Run integration tests"
vtb transition-to <ticket-id> todo

# 3. Assign workflow and start work
vtb workflow assign <ticket-id> <impl-workflow-id>
vtb transition-to <ticket-id> coding

# 4. Work through checklist items
vtb check-item <ticket-id> 1
vtb transition-to <ticket-id> testing

# ... run tests ...
vtb check-item <ticket-id> 2

# 5. Review and complete
vtb transition-to <ticket-id> review

# 6. Or start a TaskRun automatically via daemon
vtb start-taskrun <ticket-id>

# 7. Move to next
vtb ready
```

---

## Command Reference

### Task Lifecycle
| Command | Description |
|---------|-------------|
| `vtb add` | Create a new task |
| `vtb show <id>` | Show full task details |
| `vtb list` | List tasks with filters |
| `vtb update <id>` | Update task fields |
| `vtb delete <id>` | Delete a task |
| `vtb archive <id>` | Soft-delete (archive) a task |
| `vtb unarchive <id>` | Restore an archived task |
| `vtb ready` | Show actionable items |

### Dependencies
| Command | Description |
|---------|-------------|
| `vtb depend <a> --on <b>` | Create dependency (a blocked by b) |
| `vtb undepend <a> --on <b>` | Remove dependency |
| `vtb blockers <id>` | Show full blocker tree |
| `vtb path <from> <to>` | Find shortest dependency path |

### Workflow Navigation
| Command | Description |
|---------|-------------|
| `vtb transition-to <id> <target>` | Move to a step in the current workflow (by name, UUID, or short ID) |

### Workflow Management
| Command | Description |
|---------|-------------|
| `vtb workflow add` | Create a workflow |
| `vtb workflow list` | List workflows |
| `vtb workflow show <id>` | Show workflow details |
| `vtb workflow update <id>` | Update workflow properties |
| `vtb workflow delete <id>` | Delete a workflow |
| `vtb workflow assign <task> <wf>` | Assign task to workflow |
| `vtb workflow unassign <task>` | Remove workflow assignment |
| `vtb workflow transition add` | Create cross-workflow transition |
| `vtb workflow transition list` | List transitions |
| `vtb workflow transition delete` | Delete a transition |

### Step Management
| Command | Description |
|---------|-------------|
| `vtb step add <name> -w <wf>` | Create a step |
| `vtb step list <wf>` | List steps in a workflow |
| `vtb step show <id>` | Show step details |
| `vtb step update <id>` | Update step properties |
| `vtb step delete <id>` | Delete a step |

### Content
| Command | Description |
|---------|-------------|
| `vtb section <id> <type> "..."` | Add a section |
| `vtb sections <id>` | List sections |
| `vtb unsection <id> <type>` | Remove a section |
| `vtb check-item <id> <n>` | Mark checklist item as done |
| `vtb uncheck-item <id> <n>` | Uncheck an already checked checklist item |
| `vtb ref <id> "path"` | Add code reference |
| `vtb refs <id>` | List code references |
| `vtb unref <id> "path"` | Remove code reference |
| `vtb criterion-ref <id> <n> "path"` | Link code to a 1-based testing criterion |

### Execution
| Command | Description |
|---------|-------------|
| `vtb run <id>` | Execute current step via daemon |
| `vtb start-taskrun <id>` | Start a TaskRun via daemon |
| `vtb stop-taskrun <id>` | Stop the active TaskRun for a task; supports global `--json` |
| `vtb run-workflow <id>` | Compatibility alias for `start-taskrun` |
| `vtb stop <id>` | Compatibility alias for `stop-taskrun` |
| `vtb stop-workflow <id>` | Compatibility alias for `stop-taskrun` |
| `vtb execution create <task-id>` | Create execution record for a task's current workflow step |
| `vtb execution list <task-id>` | List compact TaskRun-backed executions grouped by TaskRun |
| `vtb execution list --task-run <task-run-id>` | List compact executions for one full TaskRun UUID |
| `vtb execution show <id>` | Show execution details |
| `vtb execution update <id>` | Update execution status |
| `vtb execution log <execution-id> "msg"` | Add a session log entry to a full execution UUID |

### Daemon
| Command | Description |
|---------|-------------|
| `vtb daemon install` | Install as launchd or systemd user service |
| `vtb daemon uninstall` | Uninstall launchd or systemd user service |
| `vtb daemon status` | Check daemon status |

### Other
| Command | Description |
|---------|-------------|
| `vtb init` | Initialize project |
| `vtb manifest print` | Print the clap-derived command manifest |
| `vtb manifest validate-docs` | Validate docs and skills against the manifest |
