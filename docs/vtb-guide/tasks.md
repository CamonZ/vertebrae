# Tasks

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
