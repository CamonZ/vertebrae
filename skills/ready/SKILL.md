---
name: ready
description: Show actionable items ready for work or triage
---

# /ready

Show actionable items returned by the ready query.

## When to use
- Finding what to triage or start next from the backlog
- Starting a work session by checking the current actionable queue
- Confirming dependency blockers have been cleared before selecting work

## Command

```bash
vtb ready
```

`ready` has no positional arguments or command-specific flags.

The global `--json` flag also applies:

```bash
vtb --json ready
vtb ready --json
```

## Output

```
Ready to start (backlog):
  a1b2c3  epic    New Feature Epic
  d4e5f6  ticket  Standalone Improvement
```

## How it works

Returns actionable items from the backend ready query. The CLI
filters archived items from that result, then displays each remaining item with
its ID, level, and title.

If no items are ready, the human-readable output is:

```text
No actionable items found.
```

JSON output is an object with a `backlog_ready` array containing the serialized
task records returned by the command.

## See Also

- `/list` - Full task listing with filtering
- `/blockers` - See what blocks a specific task
