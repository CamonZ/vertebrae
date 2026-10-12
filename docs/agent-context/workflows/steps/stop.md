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
- A provider conversation crosses the boundary only when the stop's edge
  carries a [session directive](route/sessions.md): its llm_inference
  destination then resumes or forks a conversation of the run that stopped
  here (see [transitions](../transitions.md#edges-leaving-a-stop-step)).
  Without one it starts a new conversation.

## Doing it
`vtb step add "Pause" -w <wf> --harness claude --step-type stop --transition-to <next>`.
Add `--transition-session <next>=resume:<step>` to continue `<step>`'s
pre-boundary conversation after the stop.
Resume later with `vtb start-taskrun <task>` (with consent).

## Gotchas
- Not the same as `vtb stop-taskrun` (an operator cancel).
- The backend rejects `persistence_options` on stop steps.

## Related
[finish](finish.md) · [TaskRuns](../../running/taskruns.md) · [Templating context](../../templating/context.md)
