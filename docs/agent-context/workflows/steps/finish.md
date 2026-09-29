# finish

Purpose: complete the task.
Use this when: a workflow path is done.

## How it works
- Reaching a finish step completes the task immediately; it is never
  dispatched to the daemon and has no outgoing transitions.
- Completion then triggers the backend: dependents with a workflow and no remaining
  blockers start, and a waiting parent is re-checked (see [wait_children](wait_children.md)).
- Prompt, agent config, output schema, transitions and `persistence_options` must be empty.

## Doing it
`vtb step add "Done" -w <wf> --harness claude --step-type finish`. Every path should end in a
finish (or a stop) so runs and parents do not hang.

## Gotchas
To keep a final summary, persist it as an artifact on the step before finish;
finish itself stores nothing.

## Related
[stop](stop.md) · [Artifacts](../../artifacts.md) · [Dependencies](../../tasks/relationships/dependencies.md)
