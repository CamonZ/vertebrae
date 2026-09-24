# Workflow TaskRuns

Start the assigned workflow as a durable TaskRun:

```bash
# Start a TaskRun for a task's assigned workflow
vtb start-taskrun <task-id>

# Start with a root TaskRun concurrency budget
vtb start-taskrun <task-id> --max-concurrency 3

# Stop the active TaskRun for a task
vtb stop-taskrun <task-id>

# Emit the stopped TaskRun (or null when none is active) as JSON
vtb --json stop-taskrun <task-id>
```

`vtb start-taskrun` starts a durable TaskRun for the task's assigned workflow,
handling transitions, eval prompts, and workflow chaining. Pass the optional
`--max-concurrency` positive integer to set the maximum number of concurrently
executing step attempts for the root TaskRun tree. The value is persisted by
Sacrum and is reported as `maxConcurrency=<value>` in human-readable run output
and as `max_concurrency` in JSON. Omitting the flag sends `null` and uses Sacrum's
global execution-pool limit. Child TaskRuns inherit the root budget; clients do
not configure child lineage or start child runs with separate limits.

`vtb stop-taskrun` stops the active TaskRun for the task
ID passed as its only positional argument. It accepts the global `--json` flag:
JSON output is the stopped `TaskRun` object, or `null` when the task has no
active TaskRun. Human-readable output reports either `Stopped run: <status>
taskRun=<task-run-id> maxConcurrency=<value> latestStep=<step-execution-id|none>`
or `No active run for task <task-id>`. TaskRun commands have no command aliases.

The CLI does not expose execution-history or detailed execution-log commands.
Sacrum records StepExecutions as steps run inside a TaskRun.
