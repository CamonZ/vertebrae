# Runs and TaskRuns

## Running Steps via Daemon

Once the daemon is running, trigger step execution:

```bash
# Run the current step for a task (dispatches to daemon)
vtb run <task-id>

# Emit the StepExecution as machine-readable JSON
vtb --json run <task-id>

# Start a TaskRun for a task's assigned workflow (automatic multi-step)
vtb start-taskrun <task-id>

# Start with a root TaskRun concurrency budget
vtb start-taskrun <task-id> --max-concurrency 3

# Stop the active TaskRun for a task
vtb stop-taskrun <task-id>

# Emit the stopped TaskRun (or null when none is active) as JSON
vtb --json stop-taskrun <task-id>
```

`vtb run` executes exactly the task's current workflow step and returns a
`StepExecution` record. It has no command alias. The only required input is
`<task-id>`; use the global `--json` flag for machine-readable output. The task
must already have an assigned workflow and current step, and a connected daemon
must be available to handle the execution. `vtb start-taskrun` starts a durable
TaskRun for the task's assigned workflow, handling transitions, eval prompts,
and workflow chaining. Pass the optional `--max-concurrency` positive integer to
set the maximum number of concurrently executing step attempts for the root
TaskRun tree. The value is persisted by Sacrum and is reported as
`maxConcurrency=<value>` in human-readable run output and as
`max_concurrency` in JSON. Omitting the flag sends `null` and uses Sacrum's
global execution-pool limit. Child TaskRuns inherit the root budget; clients do
not configure child lineage or start child runs with separate limits.

`vtb stop-taskrun` stops the active TaskRun for the task
ID passed as its only positional argument. It accepts the global `--json` flag:
JSON output is the stopped `TaskRun` object, or `null` when the task has no
active TaskRun. Human-readable output reports either `Stopped run: <status>
taskRun=<task-run-id> maxConcurrency=<value> latestStep=<step-execution-id|none>`
or `No active run for task <task-id>`. TaskRun commands have no command aliases.

`vtb run` remains the separate manual single-step path and does not accept or
apply a TaskRun concurrency budget.

The CLI does not expose manual execution-history commands. StepExecution and
TaskRun records are created by `run` and `start-taskrun`; detailed execution
logs are intentionally kept out of the CLI/agent command surface for now.
