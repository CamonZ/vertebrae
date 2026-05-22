---
name: run-workflow
description: Orchestrate a task through its entire workflow via Sacrum
---

# /run-workflow

Orchestrate a task through its entire workflow. Sends a request to the Sacrum backend which uses the TaskOrchestrator FSM to drive the task through workflow execution, eval prompts, and workflow chaining.

## Usage

```bash
vtb run-workflow <task-id>
```

## Arguments

| Argument | Description |
|----------|-------------|
| `task-id` | Task ID with an assigned workflow |

## Requirements

1. Task must have a workflow assigned
2. Task must not be already completed
3. No orchestration must already be running for the task

## Output

```
Workflow orchestration started for task a1b2c3d4
```

## Errors

If the task has no workflow:
```
Task abc123 has no assigned workflow
```

If the task is already completed:
```
Cannot orchestrate a completed task
```

If orchestration is already running:
```
Orchestration is already running for this task
```

## How It Works

1. Validates task exists and has a workflow assigned
2. Calls `orchestrate_task` mutation on the Sacrum backend via GraphQL
3. Sacrum schedules the task with the TaskOrchestrator FSM
4. The orchestrator drives the task through all workflow steps automatically

## Difference from `/run`

- `/run` executes only the current step and requires a connected daemon
- `/run-workflow` orchestrates the entire workflow server-side via Sacrum's FSM

## When to Use

- Driving a task through its complete workflow automatically
- Running multi-step orchestrated processes
- When you want Sacrum to handle step progression and chaining

## See Also

- `/run` - Run the current step only
- `/workflow assign` - Assign a workflow to a task
- `/transition-to` - Move a task to a specific workflow step
