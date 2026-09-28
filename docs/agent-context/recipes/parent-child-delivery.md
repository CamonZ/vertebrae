# Recipe: parent-child delivery

Purpose: run a parent's children to completion, then evaluate the parent.
Use this when: the user wants a parent task (e.g. an epic) delivered by automation.

## Shape
1. **Child workflow** (assigned to each child): `<do the work>` -> `<verify>` ->
   `finish`. Give each child its own `--worktree` when they change code.
2. **Parent workflow**:
   - a `wait_children` step, with a schema and `persistence_options` if you
     want to keep the snapshot;
   - a structured_inference step over `{{ steps.<wait step>.output }}`;
   - a route: done -> `finish`; needs attention -> a workflow ending in `stop`.

## Preparing (with the user's go-ahead)
- Create the children with `--parent <parent>`, `--workflow <child workflow>`,
  and `--depends-on` where order matters.
- Start one TaskRun on the parent, with `--max-concurrency` if needed.

## What happens
Unblocked children start; blocked ones start as their blockers complete; the
parent wakes when all are complete, then evaluates and routes.

## Gotchas
- Any child without a workflow fails `wait_children` (`child_missing_workflow`).
- A child whose workflow never reaches `finish` keeps the parent waiting.
- The snapshot is taken when the parent enters `wait_children`; check live
  child state if freshness matters.

## Related
[wait_children](../workflows/steps/wait_children.md) · [Parent/child](../tasks/relationships/parent-child.md) · [Concurrency](../running/concurrency.md)
