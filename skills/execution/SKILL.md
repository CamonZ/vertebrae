---
name: execution
description: Manage workflow execution history
---

# /execution

Manage workflow execution records and session logs. Tracks the history of workflow step executions for audit and debugging.

## Subcommands

| Command | Description |
|---------|-------------|
| `execution create` | Create a new execution record |
| `execution list` | List compact TaskRun-backed executions for a task or one full TaskRun UUID |
| `execution show` | Show execution details |
| `execution update` | Update execution output and result |
| `execution log` | Add a log entry to an execution |

---

## execution create

Create a new execution record for a task's current workflow step.

```bash
vtb execution create <task-id>

# With context and prompt data
vtb execution create abc12345 \
  --context '{"user": "alice", "environment": "staging"}' \
  --prompt '{"instructions": "Review the code changes"}'

vtb execution create <task-id> --json
```

### Options

| Flag | Description |
|------|-------------|
| `--context <CONTEXT>` | JSON context data about the task |
| `--prompt <PROMPT>` | JSON prompt data for the execution |
| `--json` | Output a machine-readable create result |

### Requirements

- `<task-id>` accepts a full UUID or an 8-character hex task short ID
- Task must have a workflow assigned
- Task must have a current workflow step

---

## execution list

List compact TaskRun-backed executions for a task or one exact TaskRun.

Positional input is always a task ID. Task short IDs are supported on that path.
Use `--task-run` to list executions for one TaskRun; TaskRun mode requires a full
TaskRun UUID and rejects short IDs. The list output is intentionally compact:
execution IDs, task/run grouping, step names, statuses, and timestamps. Use
`execution show <execution-id>` for detailed output and session logs.

```bash
vtb execution list <task-id>
vtb execution list --task-run <task-run-id>
```

Task output:
```
TaskRun Executions for task 89abcdef-0123-4567-89ab-cdef01234567 (2 total)
================================================================================
TaskRun: 01234567-89ab-4cde-8fab-0123456789ab
- execution ... task=89abcdef-0123-4567-89ab-cdef01234567 taskRunId=01234567-89ab-4cde-8fab-0123456789ab step=review status=IN_PROGRESS
  started=2026-05-09 12:00:00 UTC completed=-
```

TaskRun output:
```
TaskRun Executions for TaskRun 01234567-89ab-4cde-8fab-0123456789ab (1 total)
================================================================================
TaskRun: 01234567-89ab-4cde-8fab-0123456789ab
- execution ... task=89abcdef-0123-4567-89ab-cdef01234567 taskRunId=01234567-89ab-4cde-8fab-0123456789ab step=review status=COMPLETED
  started=2026-05-09 12:00:00 UTC completed=2026-05-09 12:01:00 UTC
```

---

## execution show

Show detailed execution information.

```bash
vtb execution show <execution-id>
```

---

## execution update

Update execution output and transition result.

```bash
vtb execution update <execution-id> --output "Review complete"
vtb execution update <execution-id> --transition-result advance
```

### Options

| Flag | Description |
|------|-------------|
| `--output` | Output text from the execution |
| `--transition-result` | Transition result (e.g., advance, reject, retry) |

---

## execution log

Add a log entry to an execution.

```bash
vtb execution log <execution-id> "Processing file auth.rs"
```

Takes a required content string as a positional argument.

---

## Execution Lifecycle

1. **Create**: `vtb execution create` when starting work on a step
2. **Log**: `vtb execution log` to record progress
3. **Update**: `vtb execution update` to set output and result

## When to Use

- Tracking automated workflow progress
- Debugging failed executions
- Auditing workflow history
- Recording agent interactions
