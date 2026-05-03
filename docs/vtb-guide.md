# Vertebrae (vtb) — CLI User Guide

Vertebrae (`vtb`) is a CLI client for the Sacrum GraphQL API. It provides structured workflows for planning, triaging, implementing, and reviewing work through a terminal interface.

> **Backend:** See [System Overview](system-overview.md) for how vtb fits into the broader Sacrum architecture.

## Configuration

Use `vtb init` to configure a project:

```bash
vtb init
```

The command handles registration and writes the client configuration. See [SACRUM_CONFIG.md](SACRUM_CONFIG.md) for the current config format and environment overrides.

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

Use `vtb transition-to` to move tasks between workflows and steps:
```bash
vtb transition-to <id> <target>         # Move to a step by name or UUID
```

Steps can be referenced by name (e.g., `backlog`, `in_progress`) or by UUID.

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

# Mark as needing human review
vtb add "Sensitive security change" --needs-review

# With a dependency (this task is blocked by another)
vtb add "Write integration tests" --depends-on <blocker-id>

# Assign to a specific workflow on creation
vtb add "New feature" --workflow <workflow-id>
```

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

### Section Types

| Type | Purpose | Cardinality |
|------|---------|-------------|
| `goal` | What this task achieves | Single |
| `context` | Background information | Single |
| `current_behavior` | How it works now (for bugs) | Single |
| `desired_behavior` | How it should work | Single |
| `step` | Ordered implementation steps | Multiple |
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

# Implementation steps (ordered)
vtb section <id> step "Create RequestData struct with contract and tick_list fields"
vtb section <id> step "Implement binary serialization"
vtb section <id> step "Add response parsing in from_fields/1"

# Checklist items (trackable)
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

```bash
vtb sections <id>                     # List all sections
vtb sections <id> --type step         # Filter by type
```

### Editing and Removing Sections

```bash
# Edit a section in-place (type + 0-based ordinal + new content)
vtb update <id> --edit-section step 0 "Updated step content"

# Remove a section (type + 0-based ordinal)
vtb update <id> --remove-section step 0

# Remove single-instance types (no index needed)
vtb unsection <id> goal
vtb unsection <id> context

# Remove multi-instance types (index required)
vtb unsection <id> step --index 2
vtb unsection <id> testing_criterion --index 1
```

### Checklist Items

Checklist items can be checked and unchecked to track progress:

```bash
# Mark checklist item #1 as done (1-based index)
vtb check-item <id> 1

# Uncheck item #2
vtb uncheck-item <id> 2

# View checklist status via show
vtb show <id>
```

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
| `step` | **1** | Implementation steps |
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
```

---

## Workflows and Steps

Workflows define the stages a task progresses through.

### Creating Workflows

```bash
# Basic workflow with inline steps (format: name:model)
vtb workflow add "Implementation" --step Coding:sonnet --step Testing:haiku --step Docs:haiku

# With description, auto-advance, and kanban column
vtb workflow add "Code Review" \
  -d "Review and approval process" \
  --step Review:sonnet \
  --step Approved:haiku \
  --auto-advance \
  --kanban-column "In Review"

# Mark as default workflow for new tasks
vtb workflow add "Standard" --step Backlog:sonnet --step Done:haiku --default

# Set display order
vtb workflow add "Triage" --order 1
```

### Managing Workflows

```bash
vtb workflow list                                  # List all workflows
vtb workflow show <workflow-id>                    # See steps and details
vtb workflow update <id> --name "Dev"              # Rename
vtb workflow update <id> --auto-advance            # Enable auto-advance
vtb workflow update <id> --no-auto-advance         # Disable auto-advance
vtb workflow update <id> --kanban-column "Active"  # Set kanban column
vtb workflow update <id> --default                 # Mark as default
vtb workflow update <id> --no-default              # Unmark as default
vtb workflow delete <workflow-id>                  # Delete (no assigned tasks allowed)
```

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
  --prompt "Implement the task described in {task_id}" \
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

# Add a routing step
vtb step add "Router" -w <workflow-id> --step-type route

# List, show, update, delete steps
vtb step list <workflow-id>
vtb step show <step-id>
vtb step update <step-id> --goal "New goal" --model opus
vtb step update <step-id> --prompt "New prompt for {task_id}"
vtb step update <step-id> --step-type evaluate
vtb step update <step-id> --output-schema '{"type":"object"}'
vtb step update <step-id> --clear-output-schema
vtb step update <step-id> --clear-agents --clear-skills
vtb step delete <step-id>
```

### Step Properties

| Property | Description |
|----------|-------------|
| `name` | Step name (e.g., "backlog", "coding", "review") |
| `order` | Execution order (lower = first, 0-indexed) |
| `final` | Marks workflow as complete when reached |
| `goal` | What this step accomplishes |
| `prompt` | Template sent to the executing agent (supports `{task_id}` interpolation) |
| `model` | AI model shortcut (sonnet, haiku, opus) |
| `agent-config` | Full LLM config JSON (model, budget, tools, permissions) |
| `agents` | Agent file paths for AI-assisted execution |
| `skills` | Slash commands available during this step |
| `transition-to` | Restrict which steps can follow this one |
| `step-type` | Type of step: `execute`, `evaluate`, `route`, or `wait_children` (see below) |
| `output-schema` | JSON Schema for structured output enforcement (see below) |

### Step Types

Each step has a `--step-type` that determines its role in the workflow:

| Type | Description |
|------|-------------|
| `execute` | **Default.** Runs the step's prompt via Claude and produces output. |
| `evaluate` | Assesses the output of a previous step. Used with `eval_prompt` to determine which transition to follow when a step has multiple outgoing paths. |
| `route` | Directs work to different paths based on conditions. Uses a fixed routing contract schema. |
| `wait_children` | Parent/child orchestration barrier — pauses the parent until all child tasks complete. Handled server-side by Sacrum; the daemon does not execute this step type directly. |

```bash
# Set step type on creation
vtb step add "Eval" -w <wf-id> --step-type evaluate

# Change step type later
vtb step update <step-id> --step-type route
```

When a step has type `evaluate` and multiple outgoing transitions, the daemon runs a separate evaluation execution whose output is matched against transition labels to determine the next step — creating a **branching state machine** driven by AI judgment.

### Output Schemas

Steps can define an `output_schema` — a JSON Schema describing the expected structured output from Claude. When present:

- The daemon passes it as `--json-schema` to the Claude CLI subprocess, enforcing structured output
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

---

## Moving Tasks Between Workflows and Steps

### Cross-Workflow Transitions (`transition-to`)

Use `transition-to` to move tasks across workflows or to specific steps. The target can be a step name or UUID.

```bash
# Move to a step by name
vtb transition-to <id> backlog
vtb transition-to <id> in_progress

# Move to a step by UUID
vtb transition-to <id> <step-uuid>

# Force past warnings
vtb transition-to <id> <target> --force

# Bypass validation entirely (escape hatch)
vtb transition-to <id> <target> --skip-validation
```

### Workflow Transitions (between workflows)

Define allowed transitions between workflows:

```bash
# Create transition rule
vtb workflow transition add <from-workflow> <to-workflow> --label "approve"

# With target step in destination
vtb workflow transition add <from-workflow> <to-workflow> \
  --label "escalate" --target-step <step-id>

# List and delete transitions
vtb workflow transition list
vtb workflow transition list --workflow-id <id>
vtb workflow transition delete <from-workflow> <to-workflow>
```

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

- **`transition-to`** is for moving to any step (by name or UUID)
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
```

### Removing Dependencies

```bash
vtb undepend <task-a> --on <task-b>
```

### Viewing Dependencies

```bash
# Full blocker tree for a task
vtb blockers <task-id>
vtb blockers <task-id> --depth 2        # Limit depth
vtb blockers <task-id> --all            # Include completed blockers

# Shortest path between two tasks
vtb path <from-task> <to-task>
```

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

# View and remove references
vtb refs <id>
vtb unref <id> "src/service.rs"
vtb unref <id> --all
```

---

## Querying Tasks

### Listing

```bash
vtb list                              # All tasks (tree view, excludes done/archived)
vtb list --flat                       # Flat table view
vtb list --workflow <workflow-id>     # By workflow
vtb list --step <step-id>             # By current step UUID
vtb list -w <wf-id> --step <step-id>  # Combine workflow and step UUID
vtb list --level ticket               # By level (can repeat: -l epic -l ticket)
vtb list --priority high              # By priority (can repeat)
vtb list --tag backend                # By tag (can repeat)
vtb list --parent <id>                # Children of a specific parent task
vtb list --root                       # Only root items (no parent)
vtb list --search "auth"              # Search title/description (case-insensitive)
vtb list --all                        # Include done items
vtb list --include-archived           # Include archived items
```

### Viewing Details

```bash
vtb show <id>                         # Full task details with sections, refs, relationships
```

### Finding Actionable Work

```bash
vtb ready                             # Highest-level items ready for work or triage
```

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
vtb update <id> --edit-section step 0 "New content"
vtb update <id> --remove-section step 0
```

**Never use `vtb update` for workflow/step changes** — use `vtb transition-to` instead.

---

## Deleting and Archiving Tasks

```bash
# Delete single task
vtb delete <id>

# Delete task and all children
vtb delete <id> --cascade

# Soft-delete via archive
vtb archive <id>

# Restore an archived task
vtb unarchive <id>
```

Archived tasks are excluded from `vtb list` by default. Use `--include-archived` to see them.

---

## Human Review

```bash
vtb review <id>                       # Toggle needs_human_review flag
vtb review <id> --set true            # Explicitly set
vtb review <id> --set false           # Clear
```

Tasks with `needs_human_review: true` pause automated workflow advancement.

---

## Daemon Management

The daemon (`vtb-daemon`) is a background service that executes workflow steps via Claude Code subprocesses. It runs as a macOS launchd service.

```bash
# Install as a launchd service
vtb daemon install

# Install with explicit binary path
vtb daemon install --binary /usr/local/bin/vtb-daemon

# Check daemon status
vtb daemon status

# Uninstall the service
vtb daemon uninstall
```

### Running Steps via Daemon

Once the daemon is running, trigger step execution:

```bash
# Run the current step for a task (dispatches to daemon)
vtb run <task-id>

# Orchestrate a task through its entire workflow (automatic multi-step)
vtb run-workflow <task-id>
```

`vtb run` executes a single step. `vtb run-workflow` orchestrates the task through all workflow steps automatically, handling transitions, eval prompts, and workflow chaining.

---

## Execution Tracking

Record and review workflow execution history:

```bash
# Create a new execution record
vtb execution create <task-id>

# Add log entries
vtb execution log <execution-id> "Processing..." --level info

# Update execution status
vtb execution update <execution-id> --status completed

# View execution history
vtb execution list <task-id>
vtb execution show <execution-id>
```

---

## Typical Workflow (End to End)

```bash
# 1. Plan
vtb add "Implement TickByTick support" -l epic -d "Real-time tick data"
vtb add "Add request messages" -l ticket --parent <epic-id>
vtb add "Add response parsing" -l ticket --parent <epic-id>

# 2. Document and triage tickets
vtb section <ticket-id> goal "..."
vtb section <ticket-id> step "..."
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

# 6. Or run the whole workflow automatically via daemon
vtb run-workflow <ticket-id>

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
| `vtb transition-to <id> <target>` | Move to a step (by name or UUID) |

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
| `vtb uncheck-item <id> <n>` | Uncheck a checklist item |
| `vtb ref <id> "path"` | Add code reference |
| `vtb refs <id>` | List code references |
| `vtb unref <id> "path"` | Remove code reference |
| `vtb criterion-ref <id> <n> "path"` | Link code to test criterion |

### Execution
| Command | Description |
|---------|-------------|
| `vtb run <id>` | Execute current step via daemon |
| `vtb run-workflow <id>` | Orchestrate full workflow via daemon |
| `vtb execution create <id>` | Create execution record |
| `vtb execution list <id>` | List executions for task |
| `vtb execution show <id>` | Show execution details |
| `vtb execution update <id>` | Update execution status |
| `vtb execution log <id> "msg"` | Add log entry |

### Daemon
| Command | Description |
|---------|-------------|
| `vtb daemon install` | Install as launchd service |
| `vtb daemon uninstall` | Uninstall launchd service |
| `vtb daemon status` | Check daemon status |

### Other
| Command | Description |
|---------|-------------|
| `vtb review <id>` | Toggle human review flag |
| `vtb init` | Initialize project |
