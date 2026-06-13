---
name: run-workflow
description: Start or stop durable TaskRuns with the primary start-taskrun and stop-taskrun commands
---

# start-taskrun / stop-taskrun

Use `vtb start-taskrun` to start a durable TaskRun for a task's assigned
workflow. Use `vtb stop-taskrun` to stop the task's active TaskRun.

The installed skill file is still named `run-workflow` for compatibility with
existing skill references, but the CLI command aliases have been removed.

## Usage

```bash
vtb start-taskrun [OPTIONS] <TASK_ID>
vtb stop-taskrun [OPTIONS] <TASK_ID>

# Machine-readable output
vtb --json start-taskrun <TASK_ID>
vtb --json stop-taskrun <TASK_ID>
```

## Arguments

| Argument | Description |
|----------|-------------|
| `<TASK_ID>` | Task ID to start a TaskRun for, or the task whose active TaskRun should be stopped |

## Options

| Option | Description |
|--------|-------------|
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-h`, `--help` | Print command help |

## Requirements

1. Starting requires a task with a workflow assigned
2. The task must not already have an active TaskRun when starting
3. A connected daemon must be available for workflow execution
4. Stopping requires the task ID whose active TaskRun should be stopped

## Output

Start output:

```
Run: a1b2c3d4 (task: 89abcdef, status: queued)
```

Stop output:

```
Stopped run: stopping taskRun=a1b2c3d4-0000-4000-8000-000000000001 latestStep=none
```

When no active TaskRun exists:

```
No active run for task 89abcdef-0123-4567-89ab-cdef01234567
```

JSON stop output is the stopped `TaskRun` object, or `null` when no active run
exists.

## Errors

When starting, if the task has no workflow:

```
Task abc123 has no assigned workflow
```

## How It Works

1. `start-taskrun` validates that the task exists and has an assigned workflow
2. The backend creates a durable TaskRun and broadcasts work to connected daemons
3. The daemon executes workflow steps and reports progress back to Sacrum
4. `stop-taskrun` asks the backend to stop the active TaskRun for the task

## Difference from `/run`

- `/run` executes only the current step and requires a connected daemon
- `start-taskrun` creates a durable multi-step TaskRun for the task's assigned workflow
- `stop-taskrun` stops the active TaskRun for a task and returns the stopped run, `No active run for task <TASK_ID>`, or `null` with `--json`

## When to Use

- Driving a task through its assigned workflow automatically
- Running multi-step orchestrated processes
- Stopping a task's active TaskRun with `stop-taskrun`

## See Also

- `/run` - Run the current step only
- `/workflow assign` - Assign a workflow to a task
- `/transition-to` - Move a task to a specific workflow step
