---
name: ref
description: Link tasks to code locations
---

# /ref

Link tasks to code locations.

## Add references

```bash
# File only
vtb ref <task-id> "src/auth.rs"

# Specific line
vtb ref <task-id> "src/auth.rs:L42"

# Line range
vtb ref <task-id> "src/auth.rs:L42-60"

# With name/description
vtb ref <task-id> "src/auth.rs:L42" --name "verify_token" --desc "Token validation logic"
```

Line numbers must have an `L` prefix: `file:L42` or `file:L42-60`. A spec
without it, such as `src/auth.rs:42-60`, is stored as a file path named
`src/auth.rs:42-60`, and the CLI only prints
`Warning: file '...' does not exist`. If you see that warning, remove the bad
ref with `vtb unref <task-id> "<exact stored path>"` and add it again with the
`L`.

## View/remove references

```bash
vtb refs <task-id>                    # List all
vtb unref <task-id> --all             # Remove all
vtb unref <task-id> "src/auth.rs"     # Remove by exact file path
```

## Why refs matter
- Links tasks to actual code locations
- Provides context when starting work
- Tracks which files a task affects
