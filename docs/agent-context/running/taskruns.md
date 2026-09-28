# TaskRuns

Purpose: start, stop and understand durable runs.
Use this when: the user wants to run a task or asks about a run's state.

## How it works
- A TaskRun executes the task's assigned workflow from its current step,
  following transitions and routes (across workflows) until a `finish`, a
  `stop`, a failure, or an operator stop.
- Statuses: `queued`, `executing`, `waiting` (e.g. on children), `stopping`,
  then terminal `stopped`, `completed` or `failed`.
- Each step attempt is a step execution; a failed attempt does not fail the run until retries run out.
- `vtb show <id>` reports the run state and whether it is runnable/stoppable.

## Doing it (each needs consent)
- `vtb start-taskrun <task-id> [--max-concurrency N]`
- `vtb stop-taskrun <task-id>`

## Gotchas
- Assign a workflow first; a task at the wrong step starts from that step.
- A new run has no `steps.*` history. Starting mid-workflow breaks templates
  that reference earlier steps (see [templating context](../templating/context.md)).
- After asking to start a run, do not poll it unless the user asks you to monitor.

## Related
[Retries and recovery](retries-and-recovery.md) · [stop](../workflows/steps/stop.md) · [Permissions](../permissions.md)
