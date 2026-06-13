---
name: run
description: Execute a workflow step for a task via the daemon
---

# /run

Execute the current workflow step for a task. The command validates that the
task has an assigned workflow and current step, then asks the connected daemon
to start that step execution.

## Usage

```bash
vtb run <task-id>
vtb --json run <task-id>
```

## Arguments

| Argument | Description |
|----------|-------------|
| `task-id` | Task ID with an assigned workflow and current step |

## Options

| Option | Description |
|--------|-------------|
| `--json` | Global flag; output the `StepExecution` object as machine-readable JSON |
| `-h`, `--help` | Print command help |

`vtb run` has no command alias. Use `vtb start-taskrun <task-id>` when you want
a durable multi-step TaskRun instead of one current-step execution.

## Requirements

1. Task must have a workflow assigned
2. Task must have a current step set
3. A daemon must be connected to handle execution

## Output

```
Execution a1b2c3d4 started (step: review, status: in_progress)
```

## Errors

If no daemon is connected:
```
No daemon is connected to handle step execution. Start the daemon with `vtb-daemon` and try again.
```

If the task has no workflow:
```
Task abc123 has no assigned workflow
```

If the task has no current step:
```
Task abc123 has no current step. Assign a workflow first.
```

## How It Works

1. Validates task exists, has a workflow, and has a current step
2. Calls `run_step` through the Vertebrae service layer
3. The backend creates a `StepExecution` record and broadcasts to connected daemons
4. The daemon picks up the execution and runs the step

## When to Use

- Dispatching the task's current step to a connected daemon
- Re-running one workflow step after adjusting task or workflow state
- Testing daemon step execution without starting a durable TaskRun

## See Also

- `/workflow assign` - Assign a workflow to a task
- `/transition-to` - Move a task to a specific workflow step
