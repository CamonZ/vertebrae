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

## Answering a waiting gate field by field

A waiting `human_input` gate whose output schema Sacrum accepts field by field
(every top-level property a string, number, integer, boolean, string enum, or
array of string enum) keeps a durable draft. `vtb gate` reads and fills it:

```bash
# Record answers; keys are the schema's properties, null clears one
vtb gate set <execution-id> --values '{"approved": true}'

# Show the answers recorded so far and what is still needed
vtb gate show <execution-id>

# Resolve the gate from the complete draft
vtb gate submit <execution-id>
```

`<execution-id>` is the full ID of the run's waiting StepExecution
(`latestStep=` in `vtb show <task>`). `set` and `show` print the recorded
answers, any invalid values with their JSON path, then either `Still needed:
<fields>` or `Complete — confirm with the user, then submit`; Sacrum, not the
caller, decides what is missing. `submit` resolves the gate exactly as
attaching its artifact does. With the global `--json` flag every command
prints the draft (`execution_id`, `values`, `missing`, `invalid`, `complete`,
`updated_at`). Rejections name the problem: an unknown field, a value that
violates the schema, a draft still missing required fields, a gate that does
not accept drafts or names no artifact, and an execution that is no longer
waiting. A gate that is not draftable is resolved with `vtb artifact add`.
