# Dependencies

### Creating Dependencies

```bash
# Task A depends on task B (B must finish before A can start)
vtb depend <task-a> --on <task-b>

# Short IDs are accepted anywhere a task ID is accepted
vtb depend <task-a-short-id> --on <task-b-short-id>

# Machine-readable output
vtb depend <task-a> --on <task-b> --json
```

### Depend Options

```bash
vtb depend [OPTIONS] --on <BLOCKER_ID> <ID>
```

| Flag | Description |
|------|-------------|
| `<ID>` | Required task ID to block; accepts a full UUID or 8-character short ID, case-insensitive |
| `--on <BLOCKER_ID>` | Required blocker task ID; accepts a full UUID or 8-character short ID, case-insensitive |
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-h, --help` | Print command help |

`vtb depend` has no aliases, no short flags, and no defaults. Under `--json`,
the command returns `task_id`, `blocker_id`, and `already_existed`.

Adding the same dependency again is idempotent: the command succeeds and reports
that the dependency already exists. The command rejects malformed IDs before
execution, unknown or ambiguous short IDs during ID resolution, missing tasks in
the service layer, self-dependencies, and dependencies that would create a
cycle.

### Removing Dependencies

```bash
# Task A no longer depends on task B
vtb undepend <task-a> --on <task-b>

# Short IDs are accepted anywhere a task ID is accepted
vtb undepend <task-a-short-id> --on <task-b-short-id>

# Machine-readable output
vtb undepend <task-a> --on <task-b> --json
```

### Undepend Options

```bash
vtb undepend [OPTIONS] --on <BLOCKER_ID> <ID>
```

| Flag | Description |
|------|-------------|
| `<ID>` | Required task ID to remove the dependency from; accepts a full UUID or 8-character short ID, case-insensitive |
| `--on <BLOCKER_ID>` | Required blocker task ID to remove; accepts a full UUID or 8-character short ID, case-insensitive |
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-h, --help` | Print command help |

`vtb undepend` has no aliases, no short flags, and no defaults. Under `--json`,
the command returns `task_id`, `blocker_id`, and `existed`.

Removing an existing dependency succeeds and reports that the task no longer
depends on the blocker. Removing a dependency that is not present also succeeds
and reports a warning in human-readable output, with `existed: false` under
`--json`. The command rejects malformed IDs before execution and unknown or
ambiguous short IDs during ID resolution. The source task must exist. A
non-existent full UUID blocker can still report `existed: false` when the source
task does not depend on it; service failures while removing an existing
dependency are reported as errors.

### Viewing Dependencies

```bash
# Full blocker tree for a task
vtb blockers <task-id>
vtb blockers <task-id> --depth 2        # Limit depth
vtb blockers <task-id> --all            # Include blockers in the done workflow step
vtb blockers <task-id> --json           # Emit task_id, task_title, blockers, total_count

# Shortest path between two tasks
vtb path <from-task> <to-task>
vtb path <from-task> <to-task> --json
```

`vtb blockers` hides blockers whose current workflow step is `done` unless
`--all` is passed. The `--depth` flag is unlimited by default and accepts a
non-negative integer depth.

### Path Options

```bash
vtb path [OPTIONS] <FROM_ID> <TO_ID>
```

| Flag | Description |
|------|-------------|
| `<FROM_ID>` | Required source task ID; accepts a full UUID or 8-character short ID, case-insensitive |
| `<TO_ID>` | Required target task ID; accepts a full UUID or 8-character short ID, case-insensitive |
| `--json` | Global flag; output machine-readable JSON instead of human-readable text |
| `-h, --help` | Print command help |

`vtb path` has no aliases, no command-specific flags, and no defaults. It
traverses `depends_on` edges with breadth-first search and returns the shortest
path from source to target. If both arguments refer to the same task, human
output is `Same task: <id> "<title>"`. If no path exists, the command prints
`No dependency path from <from_id> to <to_id>` and still exits successfully.
Under `--json`, the command returns `from_id`, `to_id`, and `path`; `path` is
`null` when no path exists, otherwise it is an ordered array of task summaries
with `id` and `title`.

Malformed IDs are rejected by CLI parsing. Unknown or ambiguous 8-character
short IDs fail during ID resolution. Both resolved tasks must exist before path
search runs.

---
