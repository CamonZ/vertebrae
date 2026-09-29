# stop

Purpose: end the current TaskRun at a known point without completing the task.
Use this when: work should pause (for review, a schedule, or a human) and resume in a new run.

## How it works
- When a run reaches a stop step, the backend stops the TaskRun as `stopped` with
  `outcome_kind=run_boundary`, leaves the task incomplete, and dispatches nothing.
- The step must have exactly one outgoing transition; the next TaskRun on the
  task continues through it.
- The next run is a new TaskRun: `steps.*` and `execution.*` history start
  empty. Carry anything needed across the boundary in artifacts or task content.

## Doing it
`vtb step add "Pause" -w <wf> --harness claude --step-type stop --transition-to <next>`.
Resume later with `vtb start-taskrun <task>` (with consent).

## Gotchas
- Not the same as `vtb stop-taskrun` (an operator cancel).
- The backend rejects `persistence_options` on stop steps.

## Related
[finish](finish.md) · [TaskRuns](../../running/taskruns.md) · [Templating context](../../templating/context.md)
