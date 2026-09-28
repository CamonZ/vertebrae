# Parent/child

Purpose: decompose work and run the pieces under a parent.
Use this when: splitting an epic into tickets, or a ticket into tasks.

## What you can do
Create children with `vtb add ... --parent <id>`, list them with
`vtb list --parent <id>`, and orchestrate them from the parent's workflow with
a `wait_children` step.

## How it works
- Hierarchy is only structure until a `wait_children` step runs on the parent.
  Then the backend creates a child TaskRun for every incomplete direct child,
  starts the unblocked ones, and parks the parent run in `waiting`.
- Children run their own assigned workflows. Every direct child must have a
  workflow, or the step fails (`child_missing_workflow`).
- Child runs join the parent's run tree: they share its `max_concurrency` and daemon.
- The parent wakes when every direct child is completed and none is parked in
  a waiting step of its own. See [wait_children](../../workflows/steps/wait_children.md).

## Doing it
Create the epic, then the children with `--parent`, `--workflow`, and
`--depends-on` for ordering. Then start a TaskRun on the epic (with consent).

## Gotchas
- Starting a TaskRun on a child manually creates a new root run, outside the parent's tree.
- `steps.*` and `execution.*` in the parent do not include child outputs; use
  the `wait_children_status` snapshot or artifacts.

## Related
[Dependencies](dependencies.md) · [Concurrency](../../running/concurrency.md) · [Parent-child delivery](../../recipes/parent-child-delivery.md)
