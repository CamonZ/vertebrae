---
name: path
description: Find the dependency path between two tasks
---

# /path

Find the shortest dependency path between two tasks using breadth-first search.

## Usage

```bash
vtb path <from-task> <to-task>
```

## Options

Use `vtb path --help` for the live option list. The canonical guide section in
`docs/vtb-guide.md` covers JSON output, short IDs, no-path behavior, and
validation behavior.

## Output

If the same task is given for both arguments:
```
Same task: abc123 "Task title"
```

If a path exists:
```
Path from abc123 to xyz789:

abc123    "Deploy to production"
   ↓ depends on
def456    "Run integration tests"
   ↓ depends on
ghi789    "Fix failing tests"
   ↓ depends on
xyz789    "Update test fixtures"

4 tasks in path
```

If no path exists:
```
No dependency path from abc123 to xyz789
```

## How It Works

- Traverses `depends_on` edges using BFS
- Finds the shortest path (fewest edges)
- Reports `No dependency path ...` when tasks are not connected

## When to Use

- Understanding why task A is blocked by task B
- Finding the critical path between milestones
- Debugging complex dependency chains
- Verifying expected dependencies exist

## See Also

- `/blockers` - Show all tasks blocking a specific task
- `/depend` - Create/remove dependency relationships
