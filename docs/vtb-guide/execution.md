# Execution Tracking and Runs

## Running Steps via Daemon

Once the daemon is running, trigger step execution:

```bash
# Run the current step for a task (dispatches to daemon)
vtb run <task-id>

# Emit the StepExecution as machine-readable JSON
vtb --json run <task-id>

# Start a TaskRun for a task's assigned workflow (automatic multi-step)
vtb start-taskrun <task-id>

# Compatibility alias
vtb run-workflow <task-id>

# Stop the active TaskRun for a task
vtb stop-taskrun <task-id>

# Emit the stopped TaskRun (or null when none is active) as JSON
vtb --json stop-taskrun <task-id>

# Compatibility alias
vtb stop <task-id>

# Compatibility alias
vtb stop-workflow <task-id>
```

`vtb run` executes exactly the task's current workflow step and returns a
`StepExecution` record. It has no command alias. The only required input is
`<task-id>`; use the global `--json` flag for machine-readable output. The task
must already have an assigned workflow and current step, and a connected daemon
must be available to handle the execution. `vtb start-taskrun` starts a durable
TaskRun for the task's assigned workflow, handling transitions, eval prompts,
and workflow chaining. `vtb stop-taskrun` stops the active TaskRun for the task
ID passed as its only positional argument. It accepts the global `--json` flag:
JSON output is the stopped `TaskRun` object, or `null` when the task has no
active TaskRun. Human-readable output reports either `Stopped run: <status>
taskRun=<task-run-id> latestStep=<step-execution-id|none>` or `No active run for
task <task-id>`. `vtb run-workflow`, `vtb stop`, and
`vtb stop-workflow` remain compatibility aliases for `start-taskrun` and
`stop-taskrun`.

---

## Execution Tracking

Record and review workflow execution history:

```bash
# Create a new execution record
vtb execution create <task-id>
vtb execution create <task-id> --context '{"files":["src/lib.rs"]}' --prompt '{"instructions":"Review changes"}'

# Add log entries
vtb execution log <execution-id> "Processing..."
vtb execution log <execution-id> $'Line 1\nLine 2'
vtb execution log <execution-id> "Processing..." --json

# Update execution output/result
vtb execution update <execution-id> --output "Completed"

# View execution lists/details
vtb execution list <task-id>
vtb execution list --task-run <task-run-id>
vtb execution show <execution-id>
```

`vtb execution create <task-id>` creates a `StepExecution` for the task's
current workflow step. The task ID accepts a full UUID or an 8-character hex
task short ID. The task must exist, have a workflow assigned, and have a
current step. `--context` and `--prompt` accept any JSON object; invalid JSON
fails validation before the execution is created. With `--json`, the command
returns a machine-readable create result with `command: "execution create"`,
`status: "created"`, `execution_id`, and the resolved lowercase `task_id`.

`vtb execution list <task-id>` treats the positional ID as a task ID. Task short
IDs are supported, and the output groups TaskRun-backed step executions by
`taskRunId`. Use `vtb execution list --task-run <task-run-id>` to list only the
executions for one exact TaskRun. TaskRun mode requires a full UUID; TaskRun
short IDs are not supported. `execution list` stays compact and does not render
TaskRun trees or session log content; use `execution show <execution-id>` for
the detailed log/output view.

`vtb execution log <execution-id> <content>` adds one session log entry to an
existing step execution. The execution ID must be a full UUID; short execution
IDs are rejected by CLI parsing. The required content argument may include
newlines; quote it in your shell when needed. The command does not read content
from stdin. The command fails before creating a log if the execution does not
exist. Human output prints the short log ID, short execution ID, and a content
preview; long previews are truncated to 50 characters and multiline previews
are flattened to spaces. With `--json`, the command returns
`command: "execution log"`, `status: "created"`, `execution_id`, and `log_id`.

---
