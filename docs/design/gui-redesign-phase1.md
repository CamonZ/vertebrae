# Vertebrae — Operator Console & Workflow Engine Redesign

## Product Vision

Vertebrae is a **goal-driven autonomous execution engine**. Users define what needs to be achieved (goals with measurable acceptance criteria), and the system orchestrates AI agents through multi-step workflows to get there.

The GUI is the **operator console**. The user is overseeing agents doing work, not doing the work themselves. The fundamental question the UI answers is: *"Is the machine running well, and where do I need to intervene?"*

This is not project management with AI bolted on. It's an orchestration system with a human oversight interface. The difference matters for every design decision.

### Use case: Running a company autonomously

Imagine automatically running business operations across domains:

- **Marketing**: user segmentation, persona refinement, ad copy generation — each a multi-step workflow
- **User Insights**: preprocessing feedback, categorizing data, deriving commonalities, product ideation — another set of workflows
- **Engineering**: technical refinement, acceptance scenario creation, implementation, QA/review — another set

As part of a bigger business goal, you run multiple workflows across these domains. Some workflows map to classical kanban columns (TODO, In Progress, Review, Done). The system routes work, executes steps via agents, evaluates outputs, and surfaces only what needs human attention.

## Core Concepts

### ~~Track~~ (REMOVED)

~~A named domain of work.~~ Removed — all projects are single-domain (engineering/coding). Freeform string tracks created a validation problem (typos silently create phantom tracks). Making tracks a first-class entity added complexity for no practical value. Default workflows are project-level instead.

### Kanban Column

A string field on workflows (`workflow.kanban_column = "in_progress"`). Declares which kanban column tasks in this workflow belong to.

- Tasks inherit their kanban position from their **current workflow**
- When a task transitions between workflows, its kanban column changes automatically
- The Board view groups tasks into columns based on this
- Workflows *pass through* kanban columns — a workflow like "implementation" might be "in_progress", while "qa-review" might be "review"

### Goal (Phase 2)

A requirements entity — the "what and why" something needs to get done. Not a task, not an epic.

- Has versioned, measurable **acceptance criteria** (functional and non-functional requirements)
- Criteria can be **human-validated** or **machine-validated**
- Criteria are **continuously evaluated** — they can regress (met at time X, broken at time Y by a new change)
- Goals span multiple workflows and epics
- Multiple epics can serve the same goal
- **Goal vs Epic**: An epic is a large body of work ("build onboarding flow"). A goal is an outcome ("new users activate within 3 minutes"). A goal defines what needs to be true; tasks/epics are the work that makes it true.

## Current System State (important for implementers)

### Sacrum Backend (Elixir/Phoenix)

**What already exists:**
- `step_transitions` table with `from_step_id`, `to_step_id`, `label` — this is already the DAG edge model
- `eval_prompt` field on workflow steps — used for routing decisions
- `TaskOrchestrator` gen_statem FSM with states: initializing → awaiting_execution → executing → evaluating → transitioning → completing
- The evaluating state already handles eval_prompt to pick a transition by label — but currently expects a **single label**, not multiple
- Prompt templating exists but is minimal: only `{task_id}` and `{output}` string replacement in `ExecutionDispatcher`
- `is_default` flag on workflows — **per-project**, needs uniqueness constraint and validation
- `on_done_workflow_id` and `on_reject_workflow_id` for workflow chaining
- `metadata: map` on workflows — could store kanban_column, but a first-class field is cleaner
- `StepExecution` records store: status, output, transition_result, prompt, model, tokens, cost, duration_ms
- `SessionLog` records store full agent conversation per execution
- Phoenix channels broadcast all entity changes per project in real-time
- Daemon connects with `client_type: "daemon"`, receives `run_step` events, executes Claude CLI, reports back

**What doesn't exist:**
- Default workflow uniqueness constraint (multiple can be `is_default = true`)
- Default workflow validation (no inbound transitions check)
- Rich prompt templating (template engine with task/execution context)
- Multi-outcome eval (returning `Vec<String>`)
- Fan-out/fan-in orchestration
- Goal entity

### Vertebrae (Rust — CLI, GUI, Core, Daemon)

**What already exists:**
- Core service traits: TaskService, WorkflowService, StepService, ExecutionService
- Step model has `transitions_to: Vec<String>` (maps to step_transitions in Sacrum)
- Workflow model has `metadata: HashMap<String, String>`
- CLI has 26+ commands for task/workflow/step management
- GUI has three views: Tasks (list/tree), Workflows (grid), Pipeline (React Flow canvas)
- GUI real-time via WebSocket + Zustand stores
- Daemon crate with ractor actors: DaemonSupervisor → ProjectSupervisor → StepExecutor
- Daemon spawns Claude CLI processes, streams stdout as SessionLogs

**What doesn't exist:**
- `is_default` not wired through core model (exists in API response but dropped)
- GUI Operations view, Board view
- Multi-window scoped chat
- Task detail panel with progress-first layout

### Architecture Decision: Orchestration Lives in Sacrum

The daemon just executes individual steps — it receives a `run_step` event with a pre-rendered prompt, spawns Claude CLI, and reports back. **All routing, fan-out detection, fan-in waiting, loop termination, and eval-based transition logic belongs in Sacrum's TaskOrchestrator.** The daemon doesn't decide what to execute next.

## GUI Information Architecture

### Navigation

64px collapsed sidebar with icons, persistent across all views:

```
┌──────────────────┐
│ V (logo)         │
├──────────────────┤
│ ◉ Operations     │  ← default view
│ ▥ Board          │  ← kanban
│ ──────────────── │
│ ⚙ Design         │  ← workflow/step authoring
│ ☰ Tasks          │  ← power-user list/tree
└──────────────────┘
```

### View: Operations (default)

The primary operator view. Combines mission control with an attention feed. Calm when idle, loud when needed.

**Layout:**
- Main area with priority-ordered sections:
  1. **NEEDS ATTENTION** — failed executions. Each item has inline actions (View Logs, Retry). Red-tinted backgrounds.
  2. **LIVE** — currently executing operations. Task name → workflow/step, duration, progress. Green-tinted. For fan-out tasks, shows parallel steps side-by-side with fan-in status bar.
  3. **RECENTLY COMPLETED** — dismissible. What finished, duration, what it auto-triggered.
  4. **READY** — unblocked tasks not yet started. Start buttons.

**Data sources (all existing):**
- `StepExecution.status == in_progress` → Live
- `StepExecution.status == failed` → Needs Attention
- Tasks with all `dependency_ids` resolved but not started → Ready (existing `list_ready` query)
- Recent `StepExecution.status == completed` → Recently Completed

### View: Board (Kanban)

Tasks as cards in columns defined by their workflow's `kanban_column`.

- Filter bar: Level dropdown, Search
- Columns derived from distinct `kanban_column` values (e.g., TODO, IN PROGRESS, REVIEW, DONE)
- Cards show: title, workflow name, step progress bar, status indicator
- Cards move automatically as tasks transition between workflows
- Click card → task detail panel

### View: Design

The existing pipeline view, repositioned as a configuration/authoring tool.

- Create/edit workflows, steps, transitions
- Set `kanban_column` on workflows
- Mark default workflow for project
- Wire step transitions (DAG editor)
- View step prompt templates, eval prompts, declared outcomes
- This is where you build the system, not where you operate it

### View: Tasks

Existing tasks page with extensions:
- Added filter: kanban column
- Otherwise unchanged — power-user tool for finding and bulk-managing tasks

### Detail Panels

Side panels that appear from any view. Restructured for operator intent.

**Task detail panel:**
- Header: title, workflow → step breadcrumb, status badge (glows if executing)
- **PROGRESS** (most prominent): step-by-step execution timeline. Completed = green check + duration. Executing = amber pulse. Pending = gray. Expandable session log for latest execution.
- **ACCEPTANCE CRITERIA**: criteria items with met/not-met/pending indicators and human/machine validation type badges. Uses existing `testing_criterion` sections.
- **SPEC**: goal, constraints, testing criteria (collapsible)
- **DEPENDENCIES**: blocked by, blocking, parent
- **CODE**: file path references with line numbers

**Workflow detail panel:**
- Name, kanban_column badge, is_default indicator, ID, description
- Steps as connected vertical list (numbered, with goal, agent pills, transition arrows)
- Tasks currently in this workflow
- Transitions to/from other workflows
- Default-for-project indicator

**Step detail panel:**
- Name, workflow breadcrumb, order badge
- Goal text
- Prompt template (dark code-block, monospace, `{{ }}` variables highlighted)
- Eval prompt template
- Declared eval outcomes as editable pills
- Transitions table: outcome → target step
- Agents/skills pills
- Max retries
- Recent executions (last 3-5 with status, duration)

### Chat Windows

Multiple independent agent sessions, not a single unified chat. Rationale: you might simultaneously have a general project agent running, a scoped agent debugging a failed step, and another agent modifying a workflow definition.

- **General project chat**: accessible from sidebar, no entity scope
- **Scoped chat**: opened from any entity via context menu or action button
- Each window is independent with its own session
- Scope shown in header with controls to widen (step → workflow → project) or clear
- Entity context (task sections, step prompt, workflow structure, recent executions) injected into the agent's initial prompt
- Sessions persist until explicitly closed

**Scoping levels:**
- Project (general)
- Workflow (definition + tasks)
- Task (task + sections + execution context)
- Step (definition + executions + prompt/eval details)

## Visual/UX Principles

1. **Calm when idle, loud when needed** — quiet default state, prominent alerts
2. **Glanceable health** — progress bars, step counts. Density without clutter.
3. **Action at the point of awareness** — see a problem, act on it right there (retry, approve, open chat)
4. **Progressive disclosure** — summary → detail → full logs. One click per level.
5. **Scoped context** — chat inherits the entity you're looking at.

## Workflow Engine Enhancements

### Prompt Templating

Step prompts and eval prompts are templates with access to task and execution context. Replaces the current minimal string replacement (`{task_id}`, `{output}`) with a proper template engine.

```
Step "analyze" prompt_template:
  "Analyze the following data to {{ task.sections.goal }}.

   Constraints:
   {{ for constraint in task.sections.constraints }}
   - {{ constraint.content }}
   {{ end }}

   Previous step output: {{ execution.previous.output }}

   Code references:
   {{ for ref in task.code_refs }}
   - {{ ref.path }}:{{ ref.line_start }}
   {{ end }}"
```

**Available template variables:**
- `task.*` — title, description, level, tags, sections (by type), code_refs
- `execution.*` — previous step output, retry count, total duration, history
- `execution.parallel.*` — outputs from parallel steps (keyed by step name, for fan-in steps)
- `workflow.*` — name, current step index
- `goal.*` — linked goal's criteria and status (Phase 2)
- `output.*` — current step's output (eval prompts only)

Eval prompts use the same templating plus the step output, and return one or more **outcome labels** that drive transition routing.

### Transition Graph

Step transitions define a **directed graph** (not strictly acyclic — loops are supported for GAN/RLHF patterns). Each edge has a condition (outcome label). The eval result determines which edges are traversed.

```
StepTransition {
  from_step_id: String,
  to_step_id: String,
  on_outcome: String,        // edge label matching eval output
}
```

**Key principle:** The graph defines *possible* paths, not *required* paths. The eval outcome selects which edges to traverse at runtime.

**Eval returns `Vec<String>`** — one or more outcome labels. The engine activates all transitions whose `on_outcome` matches any returned label.

**Note:** Since loops create cycles, the engine needs a termination mechanism. The execution count for a given task+step combination is queryable as `{{ execution.retry_count }}` in templates, and the step can declare a `max_retries` value. The orchestrator enforces this, breaking cycles by failing/escalating when exceeded.

### Emergent Transition Patterns

Fan-out and fan-in are not explicit transition types — they emerge from the graph structure combined with eval routing.

**Fan-out (parallel execution):** When an eval returns multiple outcomes matching transitions to different steps, the task enters all those steps simultaneously. One task, multiple concurrent `StepExecution` records.

```
evaluate ──eval returns ["needs_security", "standard"]──┐
           │                                             │
           ├── on:"needs_security" ──→ security_review   │ (activated)
           ├── on:"needs_perf" ──→ perf_review           │ (not activated)
           └── on:"standard" ──→ code_quality_review     │ (activated)
```

**Fan-in (join/barrier):** A step with multiple inbound edges waits for all *active* inbound paths to complete. It only waits for paths that were actually activated — not all possible inbound edges.

```
security_review ──complete──→ synthesize  (waits for both active paths)
code_quality_review ──complete──→ synthesize
```

The fan-in step's prompt template accesses parallel outputs:
```
"Security: {{ execution.parallel.security_review.output }}
 Quality: {{ execution.parallel.code_quality_review.output }}
 Determine if the task passes QA. Respond with: pass, fail"
```

**Loops:** Edges can point to earlier steps, creating iterative refinement.

```
GAN-like:       generate → discriminate →[pass]→ next
                                        →[fail]→ generate (loop)

RLHF-like:      generate → human_review →[approved]→ done
                                         →[feedback]→ refine → generate

QA with parallel eval:
                          ┌→ security_review ──┐
                entry → evaluate → perf_review ──┼→ synthesize → decision
                          └→ code_quality ─────┘      ↓[fail]→ back to impl
```

### Execution Model Implications

- A task can have **multiple concurrent StepExecutions** during fan-out
- `task.current_step_id` becomes insufficient — active state is derived from in-progress `StepExecution` records
- Fan-in steps track which inbound paths were activated and wait only for those
- Orchestration logic (fan-out, fan-in, routing, loop detection) lives in **Sacrum's TaskOrchestrator**, not in the daemon
- The daemon just executes individual steps regardless of whether they're part of a fan-out

### Data Model Changes for Transitions

```
Step {
  prompt_template: String,          // with {{ }} template syntax
  eval_prompt_template: String,     // same, plus {{ output.* }}
  eval_outcomes: Vec<String>,       // declared possible outcomes ["pass", "fail", "needs_review"]
  transitions: Vec<StepTransition>, // edges in the graph
}

StepTransition {
  to_step_id: String,
  on_outcome: String,               // matches eval output
}
```

**Note:** Sacrum already has a `step_transitions` table with a `label` field. The `label` field maps to `on_outcome`. The main change is that the orchestrator needs to handle multiple matching labels (fan-out) rather than expecting exactly one.

## Implementation Plan

### Step 1: Data model fields (Sacrum + Vertebrae) — DONE

Added `kanban_column` to workflows. `track` was also added but is being removed (see Step 1b).

**Sacrum** (ticket: `6af594ea` — merged):
- Migration: added `kanban_column` (string, nullable) to workflows
- Migration: added `track` (string, nullable) to workflows and tasks (being reverted in Step 1b)
- GraphQL: exposed fields on types, accepted in create/update mutations

**Vertebrae** (ticket: `2cb6dd4d` — merged):
- Core models: added `kanban_column` and `track` fields (track being removed in Step 1b)
- Sacrum client: updated API types and response mapping
- CLI: added `--kanban-column` and `--track` flags (track being removed in Step 1b)
- GUI types: added fields, regenerated bindings

### Step 1b: Remove track field (Sacrum + Vertebrae)

Tracks were designed for multi-domain projects (marketing, engineering, insights in one project). In practice, all projects are single-domain (engineering/coding). Freeform string tracks also create a validation problem — typos silently create phantom tracks with no workflows. Making tracks a first-class entity adds significant complexity for no practical value. Removing.

**Sacrum** (ticket: `4a2ee838`):
- Migration: drop `track` column from workflows and tasks
- Remove from schemas, GraphQL types, filters, create/update mutations

**Vertebrae** (ticket: `4567bdf9`):
- Remove `track` from core Workflow and Task models, create/update options
- Remove from sacrum-client API types and GraphQL queries
- Remove `--track` flag from CLI commands
- Remove from GUI bindings

### Step 2: Default workflow validation and auto-assign (Sacrum + Vertebrae)

Project-level default workflow with validations. When a task is created with no workflow, auto-assign the project's default workflow.

**Sacrum** (ticket: `82e50b3e`):
- Validate on create/update: only one workflow per project can be `is_default = true`
- Validate: default workflows must have no inbound `workflow_transitions` (they're always the entry point)
- Return appropriate error messages for validation failures
- `maybe_assign_default_workflow()` already works at project level — ensure it enforces the single-default constraint

**Vertebrae** (ticket: `7b333a40`):
- Add `is_default` field to core Workflow model (currently in API response but dropped during conversion)
- Wire through sacrum-client: pass in create/update mutations, preserve in response conversion

**Vertebrae** (ticket: `afaa6401`):
- CLI: add `--default`/`--no-default` flag to `vtb workflow add` and `vtb workflow update`
- Display `is_default` in workflow list and show output

**Vertebrae** (ticket: `6256bcc5`):
- GUI: display `kanban_column` and `is_default` on workflow cards and detail panels
- Update TypeScript bindings to include these fields

### Step 3: GUI navigation restructure

New sidebar and routing. Existing views repositioned under new routes. No new views built yet — placeholders where needed.

- Sidebar: Operations, Board, dynamic Track entries, Design, Tasks
- Routes: `/operations`, `/board`, `/design`, `/tasks`
- Operations → placeholder or redirect to Tasks initially
- Board → placeholder initially
- Design → existing pipeline view (for workflow authoring)
- Tasks → existing tasks page

### Step 4: Kanban board view (GUI)

New page. Data available from Step 1.

- Tasks grouped by `workflow.kanban_column`
- Filterable by level, search
- Cards: title, workflow name, step progress bar
- Click card → task detail panel

### Step 5: Operations view (GUI)

New page. Built entirely from existing data sources.

- Needs Attention: `StepExecution.status == failed`
- Live: `StepExecution.status == in_progress` with duration, workflow/step info
- Recently Completed: recent completed executions, dismissible
- Ready: `list_ready` query (tasks with all deps resolved, not started)

### Step 6: Task detail panel restructure (GUI)

Rearrange existing components into new layout.

- Progress section first (execution timeline, session logs)
- Acceptance criteria (existing `testing_criterion` sections, displayed with met/not-met indicators)
- Spec section (goal, constraints, etc.)
- Dependencies section
- Code section

### Step 7: Rich prompt templating (Sacrum)

Replace `String.replace` in `ExecutionDispatcher` with a proper template engine.

- Choose engine (EEx built-in, Mustache library, or custom)
- Template variables resolved from task + execution context
- Apply to both `prompt` and `eval_prompt` fields
- Backward compatible: templates without `{{ }}` work as plain text

### Step 8: Multi-outcome eval + fan-out/fan-in (Sacrum)

Major orchestration change to the TaskOrchestrator FSM.

- Evaluating state: parse eval result as `Vec<String>` outcomes (currently single string)
- Match outcomes against `step_transitions.label` — multiple matches → launch parallel StepExecutions
- Fan-in detection: step with multiple inbound `step_transitions` waits for all *active* inbound executions
- Task active state derived from in-progress StepExecution records, not `current_step_id`
- Execution count per task+step queryable for loop termination (query `step_executions` table)

### Step 9: Multi-window scoped chat (GUI)

Multiple independent Claude sessions with context injection.

- General project agent + entity-scoped agents
- Scope levels: project, workflow, task, step
- Entity context injected into agent's initial prompt
- Window management: tabs or floating panels
- Each session independent, persists until closed

### Dependencies

```
Step 1 (data fields) — DONE
Step 1b (remove track) ← Step 2 (default workflow + display fields)
Step 2 ← Step 3 (nav restructure)
Step 3 ← Step 4 (kanban board)
Step 3 ← Step 5 (operations view)
Step 3 ← Step 6 (detail panel)
Step 7 (templating) — independent of GUI work, can run in parallel
Step 7 ← Step 8 (fan-out/fan-in)
Step 5 ← Step 9 (scoped chat)
```

Step 1 done. Step 1b (track removal) then Step 2 (default workflow + GUI field display) are next. Steps 3-6 are GUI restructure. Steps 7-8 are backend work that runs in parallel with GUI work. Step 9 builds on earlier GUI work.

### Tickets Created

| Ticket | Project | Description | Status |
|--------|---------|-------------|--------|
| `6af594ea` | Sacrum | Add track and kanban_column fields to schema | Done |
| `2cb6dd4d` | Vertebrae | Add track and kanban_column support (core, client, CLI, GUI) | Done |
| `e8ae27d9` | Vertebrae | Parent epic: GUI Information Architecture Redesign | Active |
| `4a2ee838` | Sacrum | Remove track field from workflows and tasks | Pending |
| `4567bdf9` | Vertebrae | Remove track field from Vertebrae | Pending |
| `82e50b3e` | Sacrum | Default workflow validation and project-level auto-assign | Pending |
| `7b333a40` | Vertebrae | Add is_default to core model and wire through sacrum-client | Pending |
| `afaa6401` | Vertebrae | CLI --default flag for workflow create/update | Pending |
| `6256bcc5` | Vertebrae | Display kanban_column and is_default in GUI | Pending |

### Mockups

Located in `docs/design/mockups/`:

| File | View |
|------|------|
| `operations-view-v2.png` | Operations / mission control |
| `board-view-v2.png` | Kanban board |
| `task-detail-panel-v2.png` | Restructured detail panel with acceptance criteria |
| `workflow-detail-panel.png` | Workflow detail panel |
| `step-detail-panel.png` | Step detail panel |
| `workflow-dag-view.png` | DAG view for workflow design |
| `step-editor-view.png` | Step editor with prompt templates and transitions |
| `fanout-execution-view.png` | Fan-out execution in operations view |
| `7jz1S.png` | Create task modal |
| `qe8qi.png` | Task explorer (tree view) |
| `DSvOc.png` | Full app composite (operations + detail panel + scoped chat) |

The `.pen` source file is in the Pencil editor for further iteration.

## Long-Term Vision (Phase 2+)

### Goal Entity

A requirements document with versioned, continuously evaluated acceptance criteria.

- Goals are not tasks — they define *what and why* something needs to get done
- A goal encompasses work across multiple workflows and epics
- Acceptance criteria can be human-validated or machine-validated
- Criteria are continuously evaluated — they can **regress** (met at time X, broken at time Y)
- Versioned through time: v1 has 5 criteria, v2 adds 2 and modifies 1. Work done under v1 doesn't disappear.
- The operator console (mission control) becomes goal-centric: "Goal X — 62% of tasks complete, 3/5 criteria met"

```
Goal {
  name: String,
  description: String,
  acceptance_criteria: [{
    description: String,
    validation_type: human | machine,
    status: pending | met | not_met,
    met_at: Option<DateTime>,
    evidence: [execution_ids...]
  }],
  version: u32,
  tasks: [task_ids...],
}
```

### Event-Sourced Backend

Full traceability requires storing events, not just current state. Every task creation, workflow transition, step execution, criterion evaluation becomes an immutable event. Timeline views are reconstructed from the event log.

This is a fundamental architectural change to Sacrum — CRUD operations become event producers, and current state is derived from the event stream. Phase 1 avoids this by building timelines from existing `StepExecution` timestamps, which gives a usable (if incomplete) timeline without the architectural commitment.

### Continuous Evaluation & Regression Detection

- Criteria re-evaluated on changes (new code deployed, new content generated)
- System detects when a previously-met criterion fails
- Regression triggers alerts and potentially new work in the execution system
- Evidence trail: which execution/output satisfies which criterion

### Goal-Centric Navigation

Mission control organized by goals:
- Progress toward each goal (X/Y criteria met)
- Contributing work across workflows
- Timeline of how a goal was achieved (or regressed)
- Drill from goal → workflow → step → execution → session log
