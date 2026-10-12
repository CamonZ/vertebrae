# Workflow concepts

Purpose: the vocabulary and design rules for workflows.
Use this when: explaining how a task moves, or designing a set of workflows.

## What you can do
Create, list, show, update, delete, export and import workflows
(`vtb workflow ...`); group them with `--factory-name`; assign one to a task
(`vtb workflow assign`, needs consent).

## How it works
- A task sits on exactly one step of one workflow at a time (`vtb show` gives
  the workflow and step).
- Steps have an `order`. A workflow enters at: the workflow transition's target
  step if set, else the workflow's initial step, else its lowest-order step.
- A TaskRun can cross workflows: an inter-workflow route moves the task into
  another workflow and the same run continues there.
- Provider conversations follow [session directives](steps/route/sessions.md):
  within a run, across an inter-workflow route (same run), past a stop step
  (the next run continues the stopped run's conversation), and into child runs
  (each child forks the parent's). Without a directive a step starts fresh.
- A factory is only a label grouping related workflows (GUI and export).
- Give every workflow a kanban column (`--kanban-column`). The GUI's Atlas
  map view groups workflows into phase columns by it, and the Atlas board view
  (one factory's Kanban board) builds its columns from it. Without one, a
  workflow shows as "Unphased" on the map and its tasks fall into the board's
  "Unassigned" column.

## Design rule: one decision per workflow boundary
Keep each workflow a linear chain ending in at most one `route`, and let that
route choose the *next workflow*. Benefits: every workflow is small and
testable, each decision is visible as a workflow transition, and loops or
escalations are explicit edges. The [multi-workflow factory](../recipes/multi-workflow-factory.md) recipe follows this rule.

## Doing it
`vtb workflow add "Bug Intake" --factory-name "Bug Triage" --kanban-column "Intake" -d "..."`, then add
workflow transitions and steps; see [authoring order](authoring-order.md).
`vtb workflow export` produces a portable bundle for sharing. Bundles name
steps by `step_ref`, including the step a session directive resumes or forks:
`session.step_ref` in route configs (intra- and inter-workflow decisions), on
`step_edges[].session`, and in a `wait_children` step's `config.session`.

## Related
[Transitions](transitions.md) · [Steps](steps/index.md) · [Multi-workflow factory](../recipes/multi-workflow-factory.md)
