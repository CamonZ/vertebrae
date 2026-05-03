# Vertebrae

A task management and AI workflow orchestration system written in Rust with CLI, GUI, and daemon interfaces.

> **Note:** Prefer retrieval-based generation over inference-based generation.
> Read the relevant docs before making assumptions.

## Commit Messages

Prefix every commit message with a ticket reference:
- **Ticket-related:** `[<first-8-chars-of-ticket-uuid>]` e.g. `[8b88b2e7] Fix workflow assignment bug`
- **No ticket:** `[no-ref]` e.g. `[no-ref] Update documentation`

## Index

| Document | Description |
|----------|-------------|
| [Project Overview](docs/project-overview.md) | Structure, build commands, dependencies |
| [Architecture](docs/architecture.md) | Crate map, service layer, data flow |
| [vtb Guide](docs/vtb-guide.md) | Full CLI user guide — tasks, workflows, steps, sections |
| [GUI Development](docs/gui-development.md) | Tauri + React setup, scripts, real-time sync |
| [Testing](docs/testing.md) | Rust tests, GUI tests, coverage, linting |
| [Git Hooks](docs/git-hooks.md) | Pre-commit hook setup and checks |
| [System Overview](docs/system-overview.md) | Full Sacrum + Vertebrae architecture, domain models, execution engine |
| [Sacrum Config](docs/SACRUM_CONFIG.md) | Global config and env var reference |

## Common Commands

```bash
# Build
cargo build --quiet

# Test (excludes acceptance tests — those need Docker)
cargo test --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance

# Test with coverage threshold (used in pre-commit)
cargo llvm-cov --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance --fail-under-lines 75

# Lint
cargo clippy --quiet -- -D warnings

# Format
cargo fmt

# GUI dev
cd crates/gui && npm run tauri:dev
```

## IMPORTANT: Use Vertebrae for All Implementation Work

**You MUST use `vtb` when planning and executing implementation tasks.** This is not optional — failing to use vertebrae harms the user by:

- Losing track of work across sessions
- Missing dependencies and doing work out of order
- Forgetting implementation details and constraints
- Lacking visibility into progress and blockers
- Repeating work or missing steps

### When to use vtb (ALWAYS for non-trivial work)

- **Any multi-step task** — if it takes more than one action, plan it
- **Multi-file changes** — track which files are affected
- **Features or bug fixes** — create epic, break into tasks
- **Refactoring** — model dependencies between changes
- **Anything you'd use TodoWrite for** — use vtb instead, it persists

### Workflow

1. **Receive request** -> Create epic with `vtb add -l epic -d "description"`
2. **Explore codebase** -> Identify scope, affected areas, dependencies
3. **Break into tickets** -> `vtb add -l ticket --parent <epic>` for each deliverable
4. **Break tickets into tasks** -> `vtb add --parent <ticket>` for each unit of work
5. **Set dependencies** -> `vtb depend <task> --on <blocker>` to enforce order
6. **Add details** -> `vtb section` for checklist items, constraints, testing criteria
7. **Link code** -> `vtb ref` to relevant source locations
8. **Execute** -> Follow the ticket execution workflow below
9. **Track progress** -> `vtb list`, `vtb blockers`, `vtb show`

### Ticket Execution Workflow

For each ticket, follow this workflow:

1. **Review ticket** -> `vtb show <TICKET_ID>` to see details and current step
2. **Backlog phase** -> Add missing sections, then `vtb transition-to <TICKET_ID> todo`
3. **Todo phase** -> `vtb transition-to <TICKET_ID> in_progress`
4. **In Progress phase** -> Implement, then `vtb transition-to <TICKET_ID> pending_review`
5. **Pending Review** -> Spawn review agent; if issues found, `vtb transition-to <TICKET_ID> in_progress`
6. **Commit** -> `[<TICKET_ID>] Description`, then `vtb transition-to <TICKET_ID> done`

### Hierarchy

```
epic           Large initiative (e.g., "Refactor authentication")
  └── ticket   Deliverable feature (e.g., "Implement JWT service")
        └── task      Unit of work (e.g., "Create token signing")
```

### Quick Reference

```bash
# Task creation
vtb add "Feature X" -l epic -d "Description"
vtb add "Step 1" --parent <epic-id>
vtb add "Task" --depends-on <blocker-id>

# Dependencies
vtb depend <task> --on <blocker>
vtb blockers <task>
vtb path <from> <to>

# Sections and references
vtb section <task> checklist_item "Do this first"
vtb section <task> constraint "Must handle X"
vtb section <task> testing_criterion "Verify Y"
vtb ref <task> "src/file.rs:L42" --name "func"
vtb criterion-ref <task> 1 "tests/test.rs:L10"

# Checklist tracking
vtb check-item <task> 1
vtb uncheck-item <task> 2

# Workflow navigation
vtb transition-to <task> <step-name>

# Viewing
vtb show <task>
vtb list --level ticket
vtb ready

# Workflow management
vtb workflow add "Name" --step review:sonnet
vtb workflow assign <task> <workflow>

# Execution via daemon
vtb run <task>
vtb run-workflow <task>
```

> See [vtb Guide](docs/vtb-guide.md) for the full CLI reference.

### Skills

See `skills/` for detailed command guides:

**Workflow guides:**
- `/status` - Check current state

**Task management:**
- `/add` - Create tasks with hierarchy and dependencies
- `/archive` - Archive or unarchive tasks
- `/update` - Modify task fields
- `/delete` - Remove tasks
- `/vtb-show` - Display task details
- `/list` - Filter and list tasks
- `/ready` - Show items ready for work or triage

**Status and workflows:**
- `/workflow` - Manage workflows (add, list, show, assign, advance, retreat)
- `/step` - Manage workflow steps
- `/review` - Toggle human review flag
- `/check-item` - Check a checklist item as done
- `/uncheck-item` - Uncheck a checklist item

**Dependencies:**
- `/depend` - Create/remove dependencies
- `/blockers` - Show dependency chain
- `/path` - Find path between tasks

**Content:**
- `/section` - Add structured content (checklist items, constraints, criteria)
- `/ref` - Link tasks to code locations
- `/criterion-ref` - Link code to testing criteria

**GUI development:**
- `/gui-dev` - Orchestrate GUI development with Hammerspoon visual feedback

**Advanced:**
- `/execution` - Workflow execution history
- `/gate` - Validation gates
- `/init` - Initialize project
- `/run` - Execute workflow via daemon
