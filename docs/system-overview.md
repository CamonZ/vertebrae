# Vertebrae + Sacrum: System Overview

A comprehensive description of the task management and AI workflow orchestration system, its architecture, and its role in managing LLM-based software development.

---

## What Is This System?

Vertebrae + Sacrum is a **persistent task management and AI workflow orchestration platform** designed to give LLM-based agents (primarily Claude Code) a durable, structured environment for planning and executing multi-step software engineering work.

The system solves a fundamental problem with LLM-driven development: **context is ephemeral, but work is not**. When an AI agent helps with a coding task, all planning and progress exists only in the conversation window. When the session ends, so does the plan. Vertebrae provides a persistent, shared model of work that survives across sessions, agents, and interfaces.

The platform has two components:

- **Sacrum** — an Elixir/Phoenix server (GraphQL API + PostgreSQL + Phoenix Channels) that stores all state and orchestrates workflow execution
- **Vertebrae** — a Rust client ecosystem (CLI `vtb`, desktop GUI, background daemon) that interacts with Sacrum and executes workflow steps by spawning a local harness CLI (Claude Code or Codex; see [vtb Guide — Provider Selection](vtb-guide/steps.md#provider-selection-anthropic--openai))

> The sections below describe the Claude-Code execution path in detail because that was the original and remains the default harness. With CLI-driven provider selection in place, a step whose `agent_config.provider` is `openai` is run through the Codex CLI instead, following the same actor/streaming model.

---

## Core Mental Model

Work is organized hierarchically and flows through state machines:

```
Epic (large initiative)
  └── Ticket (deliverable feature)
        └── Task (unit of work)
              └── Sections (structured annotations)
              └── Code Refs (source file links)
              └── Dependencies (blocking tasks)
              └── Workflow (step-by-step progression)
                    └── Steps (each run by an AI agent)
                          └── Executions (audit log of each run)
                                └── Session Logs (streaming output)
```

---

## The Two Servers

### Sacrum (Elixir/Phoenix Backend)

Sacrum is the single source of truth. It provides:

- A **GraphQL API** (`POST /graphql`) for all read and write operations
- **Phoenix Channels** (`ws://host/socket/websocket`) for real-time push to all connected clients
- A **workflow orchestration engine** built on OTP `gen_statem` state machines
- **PostgreSQL** persistence for all entities

All data is user-scoped and project-scoped. Every entity has `user_id` and `project_id` foreign keys. Authentication is bearer token (`Authorization: Bearer sac_<token>`), where tokens are stored as SHA256 hashes.

### Vertebrae (Rust Client Ecosystem)

Vertebrae is the interface and execution layer. It has three runnable components:

| Component | Binary | Role |
|-----------|--------|------|
| CLI | `vtb` | Human and agent-facing command interface |
| GUI | Tauri desktop app | Visual task management and monitoring |
| Daemon | `vtb-daemon` | Background worker that executes workflow steps via Claude |

All three share the same service layer abstraction (`VertebraeServices`) built on trait-based interfaces backed by the Sacrum HTTP client.

---

## Domain Models

### Task

The central entity. A task is a unit of work at any level of abstraction.

| Field | Type | Description |
|-------|------|-------------|
| `id` | UUID | Globally unique identifier |
| `short_id` | 6-char string | Human-readable prefix for lookups |
| `title` | string | Brief description |
| `description` | text | Extended context |
| `level` | enum | `epic` / `ticket` / `task` |
| `priority` | enum | `low` / `medium` / `high` / `critical` |
| `tags` | string[] | Free-form labels |
| `parent_id` | UUID? | Parent task in hierarchy |
| `workflow_id` | UUID? | Assigned workflow |
| `current_step_id` | UUID? | Current position in workflow |
| `worktree` | string? | Git worktree path for isolated execution |
| `archived` | bool | Soft-delete |
| `started_at` | datetime? | When work began |
| `completed_at` | datetime? | When work finished |

Tasks have two relationship dimensions:

- **Hierarchy** (parent/child): Epics contain tickets contain tasks
- **Dependencies** (blockers): Task A depends on Task B means B must be complete before A is actionable

### Section

Structured annotations attached to a task. Sections give tasks semantic richness beyond free-form text.

| Type | Cardinality | Purpose |
|------|-------------|---------|
| `goal` | single | What needs to be accomplished |
| `context` | single | Background and motivation |
| `current_behavior` | single | Current state of the system |
| `desired_behavior` | single | Target state after the work |
| `checklist_item` | multi | Ordered checklist with done/undone tracking |
| `testing_criterion` | multi | Acceptance criteria with optional code refs |
| `constraint` | multi | Rules the implementation must follow |
| `anti_pattern` | multi | Patterns to avoid |
| `failure_test` | multi | Edge cases to handle |

Sections can themselves have `CodeRef` attachments, linking testing criteria or constraints directly to specific source lines.

### CodeRef

A pointer to a specific location in source code.

```
path: string           # File path (relative to project root)
line_start: int?       # Starting line
line_end: int?         # Ending line
name: string?          # Function or symbol name
description: string?   # What this reference means
```

Code refs can attach to tasks (general code associations) or to individual sections (e.g., linking a `testing_criterion` to the test that validates it).

### Workflow

A named state machine defining how a task progresses through stages.

| Field | Description |
|-------|-------------|
| `name` | Human-readable name |
| `initial_step_id` | First step to execute |
| `on_done_workflow_id` | Chain to this workflow when all steps complete |
| `on_reject_workflow_id` | Chain to this workflow on rejection |

Workflows can chain: when a workflow completes, it can hand off to another workflow. This enables multi-phase processes (e.g., implement → review → deploy).

### WorkflowStep

A single stage within a workflow. Each step defines what an AI agent should do.

| Field | Description |
|-------|-------------|
| `name` | Stage name (e.g., "backlog", "in_progress", "pending_review") |
| `step_type` | `execute` (default), `evaluate`, or `route` — determines step behavior |
| `goal` | What this step accomplishes |
| `prompt` | Template sent to the executing agent |
| `eval_prompt` | Template for evaluating output and choosing next transition |
| `output_schema` | JSON Schema for structured output (passed as `--json-schema` to Claude) |
| `agents` | Agent file paths to run |
| `skills` | Skill names to enable as tools |
| `agent_config` | LLM configuration (see below) |
| `is_final` | Whether this is a terminal step |
| `transitions_to` | Step IDs reachable from this step |

**Step types:**
- **`execute`** — Standard execution. Runs the prompt via Claude and produces output.
- **`evaluate`** — Assesses previous output. Used with `eval_prompt` and multiple outgoing transitions to create branching decisions.
- **`route`** — Directs work to different paths based on conditions.

**Output schema precedence:** When a step has `output_schema`, it overrides `agent_config.json_schema`. This gives step-level structured output contracts priority over the default agent config.

### AgentConfig

Per-step LLM execution configuration:

```json
{
  "model": "claude-sonnet-4-20250514",
  "fallback_model": "claude-haiku-4-5",
  "system_prompt": "...",
  "append_system_prompt": "...",
  "allowed_tools": ["Bash", "Read", "Edit", "Write"],
  "disallowed_tools": [],
  "permission_mode": "bypassPermissions",
  "max_budget_usd": 5.00,
  "mcp_config": [],
  "json_schema": null
}
```

### StepExecution

An audit record of a single step execution run.

| Field | Description |
|-------|-------------|
| `status` | `pending` / `entered` / `in_progress` / `completed` / `failed` / `cancelling` |
| `prompt` | Rendered prompt that was sent to the agent |
| `output` | Final text result from the agent |
| `transition_result` | Eval prompt result (determines which step to transition to) |
| `model` | Which LLM was used |
| `input_tokens` | Input token count |
| `output_tokens` | Output token count |
| `cost` | USD cost of this execution |
| `duration_ms` | Wall-clock execution time |
| `session_id` | Claude Code session ID |

Each execution also has many `SessionLog` records — individual lines of streaming output from the Claude subprocess, captured in real-time.

---

## Workflow Execution: End-to-End

This is the core loop: a task moves through a workflow, and each step is executed by Claude Code autonomously.

```
1. Task assigned to workflow
   └── workflow_id set, current_step_id = initial step

2. Step execution triggered
   └── vtb run <task_id>  OR  orchestrate_task(task_id)

3. Sacrum orchestrator starts (gen_statem)
   ├── :initializing  — load workflow graph
   ├── :awaiting_execution  — acquire slot from ExecutionPool
   └── :executing  — dispatch to daemon

4. ExecutionDispatcher creates StepExecution
   ├── Status: "entered"
   ├── Renders prompt (interpolates {{task.id}})
   └── Broadcasts "run_step" on Phoenix Channel project:{project_id}

5. Daemon (vtb-daemon) receives "run_step"
   ├── DaemonSupervisor → ProjectSupervisor → StepExecutor (actor)
   ├── Builds: claude -p "<prompt>" --output-format stream-json
   ├── Runs in: project root or task.worktree (git worktree)
   └── Streams stdout line-by-line as SessionLog records

6. Claude Code executes
   ├── Reads task via vtb show <task_id>
   ├── Uses allowed tools (Bash, Edit, Read, Write, Glob, Grep, etc.)
   ├── Runs skills defined in step.skills
   └── Outputs final result as stream-json

7. StepExecutor processes completion
   ├── Parses stream-json metrics (tokens, cost, model)
   ├── Calls update_execution_status (Completed or Failed)
   └── Publishes result to Sacrum via GraphQL

8. Sacrum broadcasts step_execution_status_changed
   └── GUI receives via WebSocket, updates in real-time

9. Orchestrator catches PubSub event
   ├── If step has eval_prompt AND multiple outgoing transitions:
   │   ├── :evaluating — dispatch eval execution to daemon
   │   └── Daemon runs eval, returns transition label
   └── Else: follow single outgoing transition (or is_final)

10. :transitioning
    ├── advance_to_step(task_id, next_step_id)
    └── Loop to :executing with next step

11. :completing
    ├── If on_done_workflow: chain to new workflow (→ :initializing)
    └── Else: :completed — notify scheduler
```

### Conditional Transitions via Eval Prompts

When a step has multiple outgoing transitions (e.g., "pass" → code review, "fail" → fix bugs), the `eval_prompt` determines which path to take. The daemon runs a separate evaluation execution with the previous output interpolated into the eval prompt. The eval output is matched against transition labels. This creates a **branching state machine** driven by AI judgment.

---

## Dependency and Blocking System

Tasks form a directed acyclic graph of dependencies:

```
Task A depends_on Task B
  → B must be complete before A is actionable
  → A appears in vtb blockers output with B as a blocker
  → vtb list --status ready excludes A until B is done
```

Circular dependency detection is enforced at the database level. The system also supports:

- `find_path(from_id, to_id)` — BFS shortest path through the dependency graph
- `get_incomplete_blockers_with_details(id)` — full task objects for all blocking dependencies
- `list_ready()` — tasks with zero incomplete blockers (the actionable work queue)

---

## Real-Time Architecture

All clients (CLI mutations, GUI, daemon) share the same real-time event stream via Phoenix Channels.

```
Client type "default" receives:
  task_created, task_updated, task_deleted
  workflow_created, workflow_updated, workflow_deleted
  step_created, step_updated, step_deleted
  step_execution_created, step_execution_status_changed
  session_log_created
  section_created, section_updated, section_deleted

Client type "daemon" receives ONLY:
  run_step  (with prompt + agent_config payload)
  cancel_step
```

The daemon registers itself with `client_type: "daemon"` on channel join. This is how Sacrum selectively delivers step execution commands only to the daemon, while all other events go to human-facing clients.

The GUI maintains a WebSocket connection with 30-second heartbeats and exponential backoff reconnection (100ms → 30s). Every mutation — whether from CLI, GUI, or daemon — triggers a broadcast, keeping all views consistent.

---

## The Daemon: AI Execution Engine

The daemon (`vtb-daemon`) is the bridge between the task management system and Claude Code. It is an actor-based system (using the Ractor framework in Rust) with three actor types:

```
DaemonSupervisor
  └── ProjectSupervisor (one per connected project)
        └── StepExecutor (one per active step execution)
```

When the daemon receives a `run_step` event, `StepExecutor`:

1. Builds the Claude command from the step's `prompt` and `agent_config`
2. Spawns `claude -p "<rendered_prompt>" --output-format stream-json` as a subprocess
3. Streams each line of stdout to Sacrum as a `SessionLog`
4. On exit, parses the stream-json metadata for token counts, cost, model used
5. Reports `StepCompleted` or `StepFailed` back to `ProjectSupervisor`
6. `ProjectSupervisor` calls Sacrum's `update_execution_status` GraphQL mutation

The daemon runs Claude in the project root directory (or a git worktree if `task.worktree` is set), with the user's shell `PATH` inherited, so all tools are accessible.

---

## CLI Reference (`vtb`)

The `vtb` binary provides 26 subcommands organized into logical groups:

### Task Lifecycle
```bash
vtb add "Title" --level ticket --parent <epic-id> --depends-on <blocker-id>
vtb show <id>                    # Full task details with relationships
vtb list --level ticket --status in_progress
vtb update <id> --priority high --worktree /path/to/worktree
vtb delete <id> --cascade
vtb archive <id>
vtb ready                        # Show actionable tasks (no incomplete blockers)
```

### Dependencies & Hierarchy
```bash
vtb depend <task> --on <blocker>
vtb undepend <task> --on <blocker>
vtb blockers <task>              # Full dependency tree
vtb path <from-id> <to-id>       # Shortest path between tasks
```

### Workflow Navigation
```bash
vtb workflow advance <task>      # Move to next step
vtb workflow retreat <task>      # Move to previous step
vtb transition-to <task> <step>  # Jump to specific step
```

### Execution
```bash
vtb run <task>                   # Execute current step via daemon
vtb execution list <task>        # List compact TaskRun-backed executions for a task
vtb execution list --task-run <run> # List compact executions for one full TaskRun UUID
vtb execution show <execution>   # Show execution details and session logs
```

### Content
```bash
vtb section <task> checklist_item "Do this"
vtb section <task> testing_criterion "Verify that..."
vtb section <task> constraint "Must not break X"
vtb ref <task> "src/lib.rs:L42" --name "MyFunction"
vtb criterion-ref <task> 1 "tests/integration.rs:L10"
vtb check-item <task> 2          # Mark checklist item #2 done
```

---

## Role in LLM-Based Software Development

This system addresses several coordination problems that arise when using LLMs for complex, multi-session engineering work:

### 1. Persistence Across Sessions

LLM conversations are stateless. Vertebrae provides a persistent task graph that an agent can read at the start of any session to reconstruct context: what's being built, what's done, what's blocked, what the constraints are.

```bash
# Agent starts a session, orients itself:
vtb list --status in_progress
vtb show <task-id>          # Read full context, sections, code refs
vtb blockers <task-id>      # Understand what's blocking
```

### 2. Structured Knowledge Capture

Rather than putting implementation plans in conversation messages (which disappear), they go into task sections: goals, constraints, testing criteria, anti-patterns. Code refs link abstract requirements to concrete source locations. This knowledge is queryable and persistent.

### 3. Autonomous Multi-Step Execution

Workflows encode the stages of a development process as a state machine. The daemon executes each stage by spawning Claude Code with a stage-specific prompt and tool configuration. The orchestrator handles transitions, branching logic (via eval prompts), and workflow chaining. Complex tasks (implement → test → review → merge) run autonomously end-to-end.

### 4. Progress Tracking and Auditability

Every execution is recorded: prompt sent, output received, model used, tokens consumed, cost incurred, duration. Streaming output is captured line-by-line. A complete audit trail exists for every AI action taken on every task.

### 5. Concurrency Control

The `ExecutionPool` limits how many step executions run simultaneously, preventing daemon overload. Tasks blocked by incomplete dependencies are excluded from the ready queue, ensuring correct ordering of automated work.

### 6. Human-in-the-Loop Gates

Workflows can include steps that wait for human confirmation before proceeding. The `transition-to` operation can send a task backward in the workflow, allowing humans to override AI decisions.

### 7. Multi-Agent Coordination

Multiple agents (Claude instances, potentially different models) can work on different tasks simultaneously. The Phoenix Channel broadcasts keep all agents synchronized: when one agent completes a task and unblocks another, the second agent (whether a daemon instance, a CLI session, or a human in the GUI) sees the update in real-time.

---

## Data Flow Summary

```
Human or Agent             Sacrum Backend            Daemon (Claude)
─────────────              ──────────────            ───────────────
vtb add "feature"  ──────→ create_task
                           broadcast: task_created ──→ GUI updates

vtb workflow       ──────→ orchestrate_task
  advance <task>           Orchestrator starts FSM
                           creates StepExecution
                           broadcast: run_step ──────→ StepExecutor spawns
                                                       claude -p "<prompt>"
                                                       streams output ────────→
                           ←── session_log_created ←─ each line logged
                           ←── step_execution       ←─ on completion
                               status_changed
                           broadcast: execution
                           status changed ──────────→ GUI updates live
                           FSM transitions
                           advance_to_step
                           next step begins...
```

---

## Technology Stack Summary

| Layer | Technology | Purpose |
|-------|-----------|---------|
| Backend server | Elixir / Phoenix 1.8 | API, orchestration, real-time |
| GraphQL | Absinthe 1.7 | Typed API schema and resolvers |
| Database | PostgreSQL + Ecto | Persistent state |
| Real-time | Phoenix Channels + PubSub | Push to all clients |
| Orchestration | OTP gen_statem | Workflow state machines |
| CLI | Rust + clap | `vtb` command-line interface |
| Daemon | Rust + ractor | Actor-based step execution engine |
| GUI | Tauri 2 + React 19 | Desktop interface with WebSocket sync |
| AI execution | Claude Code (`claude -p`) | Subprocess AI agent runner |
| State management | Zustand 5 | Frontend state |
| Graph viz | XYFlow React 12 | Workflow and dependency visualization |
