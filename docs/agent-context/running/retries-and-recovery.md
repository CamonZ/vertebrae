# Retries and recovery

Purpose: what happens when a step fails and how to get a task moving again.
Use this when: a run failed or is stuck.

## How it works
- When the daemon reports a failed step execution, the backend re-dispatches the
  same step a bounded number of times (currently 5), then fails the run with outcome `retry_exhausted`.
- Dispatch-time failures (template render, graph errors) fail the run without executing.
- The task stays on the failing step.

## Recovering (each action needs consent)
1. Find the cause: [failure table](../debugging/failure-table.md), daemon logs, run outcome.
2. Fix it (step config, route, credentials, restart the daemon).
3. If later steps depend on `steps.*` from earlier in the run, move the task
   back to the workflow's first step: `vtb transition-to <task> <first-step> --skip-validation`.
4. Start a new run: `vtb start-taskrun <task>`.

## Gotchas
- `--skip-validation` bypasses transition checks; use it for recovery only, never as a graph design.
- Do not add "back" edges to non-route steps to make manual moves legal; it breaks runs.

## Related
[TaskRuns](taskruns.md) · [Debugging](../debugging/index.md)
