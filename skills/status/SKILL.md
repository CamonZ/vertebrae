---
name: status
description: Check current task state and progress
---

# /status

Check current task state and progress.

## When to use
- Resuming a session
- Checking what's in progress
- Understanding what's blocked

## Commands

```bash
# List all tasks
vtb list

# Show tasks in progress
vtb list --status in_progress

# Show what's blocking a specific task
vtb blockers <task-id>

# Show full details of current task
vtb show <task-id>

# Check daemon service status
vtb daemon status
```

If daemon-backed workflow execution is unavailable, verify the service before
retrying:

```bash
vtb daemon status
vtb daemon install --binary /path/to/vtb-daemon
```

The daemon installs as launchd on macOS or systemd `--user` on Linux.
