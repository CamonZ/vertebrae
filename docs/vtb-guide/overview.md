# Core Concepts and Workflow

## Core Concepts

### Task Hierarchy

```
epic       → Large initiative spanning multiple features
  ticket   → Single deliverable feature
    task   → Unit of work (default level)
```

### Task Position: Workflow + Step

Tasks don't have a standalone status. A task's position is defined by its **workflow** and **step** within that workflow. For example, a task might be in the `implementation` workflow at the `coding` step.

Use `vtb transition-to` to move a task to a step in its current workflow:
```bash
vtb transition-to <id> <target>         # Move to a step by name, UUID, or short ID
```

Steps can be referenced by name (e.g., `backlog`, `in_progress`), full UUID,
or 8-character short ID. To move a task to a different workflow, use
`vtb workflow assign`.

### Short IDs

Anywhere `vtb` accepts a UUID (task, workflow, or step), you can pass an
**8-character short ID** — the first segment of the UUID. The CLI resolves it
to the full UUID before calling the backend.

```bash
vtb show c249947c                    # task short ID
vtb workflow show 9c20eacc           # workflow short ID
vtb step show ab12cd34               # step short ID (project-wide lookup)
vtb workflow assign c249947c 9c20eacc  # mixed short IDs
```

Resolution is entity-scoped: an unknown task prefix and an unknown workflow
prefix surface different errors (e.g. `workflow with prefix 'deadbeef' not
found`). Ambiguous prefixes list candidates; non-hex or over-length prefixes
report `invalid short ID`. Full UUIDs continue to work everywhere.

### Priorities

`low`, `medium`, `high`, `critical`

### JSON Output

Every command supports `--json` for machine-readable output:

```bash
vtb list --json                          # JSON array of tasks
vtb show <id> --json                     # JSON task object
vtb add "Title" --json                   # JSON of created task
```

---

## Typical Workflow (End to End)

```bash
# 1. Plan
vtb add "Implement TickByTick support" -l epic -d "Real-time tick data"
vtb add "Add request messages" -l ticket --parent <epic-id>
vtb add "Add response parsing" -l ticket --parent <epic-id>

# 2. Document and triage tickets
vtb section <ticket-id> goal "..."
vtb section <ticket-id> checklist_item "..."
vtb section <ticket-id> testing_criterion "UNIT: ..."
vtb section <ticket-id> testing_criterion "INTEGRATION: ..."
vtb section <ticket-id> constraint "..."
vtb section <ticket-id> constraint "..."
vtb section <ticket-id> checklist_item "Update documentation"
vtb section <ticket-id> checklist_item "Run integration tests"
vtb transition-to <ticket-id> todo

# 3. Assign workflow and start work
vtb workflow assign <ticket-id> <impl-workflow-id>
vtb transition-to <ticket-id> coding

# 4. Work through checklist items
vtb check-item <ticket-id> 1
vtb transition-to <ticket-id> testing

# ... run tests ...
vtb check-item <ticket-id> 2

# 5. Review and complete
vtb transition-to <ticket-id> review

# 6. Or start a TaskRun automatically via daemon
vtb start-taskrun <ticket-id>

# 7. Move to next
vtb ready
```

---
