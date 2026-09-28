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
- A factory is only a label grouping related workflows (GUI and export).

## Design rule: one decision per workflow boundary
Keep each workflow a linear chain ending in at most one `route`, and let that
route choose the *next workflow*. Benefits: every workflow is small and
testable, each decision is visible as a workflow transition, and loops or
escalations are explicit edges. The [multi-workflow factory](../recipes/multi-workflow-factory.md) recipe follows this rule.

## Doing it
`vtb workflow add "Bug Intake" --factory-name "Bug Triage" -d "..."`, then add
workflow transitions and steps; see [authoring order](authoring-order.md).
`vtb workflow export` produces a portable bundle for sharing.

## Related
[Transitions](transitions.md) · [Steps](steps/index.md) · [Multi-workflow factory](../recipes/multi-workflow-factory.md)
