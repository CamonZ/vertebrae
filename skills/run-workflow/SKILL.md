---
name: run-workflow
description: Start or stop durable TaskRuns for a task via the daemon-backed workflow runner
---

# /run-workflow

Start a durable TaskRun for a task's assigned workflow. `vtb run-workflow` is a
compatibility alias for `vtb start-taskrun`; prefer `start-taskrun` in new
examples. Use `vtb stop-taskrun` to stop the task's active TaskRun.

## Usage

```bash
vtb start-taskrun <task-id>
vtb run-workflow <task-id>
vtb stop-taskrun <task-id>
vtb stop <task-id>
vtb stop-workflow <task-id>
vtb --json stop-taskrun <task-id>
```

## Arguments

| Argument | Description |
|----------|-------------|
| `task-id` | Task ID with an assigned workflow for start, or the task whose active TaskRun should stop |

## Options

| Option | Description |
|--------|-------------|
| `--json` | Global flag; for `stop-taskrun`, output the stopped `TaskRun` object or `null` when none is active |
| `-h`, `--help` | Print command help |

## Aliases

| Command | Alias of |
|---------|----------|
| `vtb run-workflow <task-id>` | `vtb start-taskrun <task-id>` |
| `vtb stop <task-id>` | `vtb stop-taskrun <task-id>` |
| `vtb stop-workflow <task-id>` | `vtb stop-taskrun <task-id>` |

## Requirements

1. Starting requires a task with a workflow assigned
2. Task must not already have an active TaskRun when starting
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

1. Validates task exists and has a workflow assigned
2. Calls the execution service to start or stop a TaskRun
3. The backend records TaskRun state and broadcasts work to connected daemons
4. The daemon executes workflow steps and reports progress back to Sacrum

## Difference from `/run`

- `/run` executes only the current step and requires a connected daemon
- `/run-workflow` / `start-taskrun` creates a durable multi-step TaskRun
- `stop-taskrun` stops the active TaskRun for a task and returns the stopped run, `No active run for task <task-id>`, or `null` with `--json`

## When to Use

- Driving a task through its assigned workflow automatically
- Running multi-step orchestrated processes
- Stopping a task's active TaskRun with `stop-taskrun`, `stop`, or `stop-workflow`

## See Also

- `/run` - Run the current step only
- `/workflow assign` - Assign a workflow to a task
- `/transition-to` - Move a task to a specific workflow step
