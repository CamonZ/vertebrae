# Dependencies

Purpose: order work with "A blocks B" edges.
Use this when: the user says one task must finish before another.

## What you can do
Add (`vtb depend <id> --on <blocker>`, or `--depends-on` at creation), remove
(`vtb undepend`), see what blocks a task (`vtb blockers <id>`, recursive), find
the chain between two tasks (`vtb path`), and list actionable work (`vtb ready`).

## How it works
- Under `wait_children`, a child with an incomplete direct blocker gets its
  child TaskRun but is not started.
- When any task completes, the backend starts every task it blocks that has a
  workflow, is not completed, and has no remaining incomplete blockers. It
  reuses that task's active TaskRun (the queued child run, for a waiting
  parent's children) or creates a new root run.
- So a blocked child starts automatically once its blockers complete.

## Gotchas
- Completing a blocker also auto-starts dependents *outside* any parent tree if
  they have a workflow. Leave the workflow unassigned if a dependent should wait
  for a human to start it.

## Related
[Parent/child](parent-child.md) · [wait_children](../../workflows/steps/wait_children.md)
