# Vertebrae

[![CI](https://github.com/CamonZ/vertebrae/actions/workflows/ci.yml/badge.svg)](https://github.com/CamonZ/vertebrae/actions/workflows/ci.yml)

A task management CLI tool written in Rust with dependency tracking and hierarchical organization.

## Features

- **Hierarchical task organization**: Epics → Tickets → Tasks
- **Dependency management**: Track blockers and dependencies between tasks
- **Status workflow**: `pending` → `in_progress` → `done` (with `blocked` state)
- **Rich metadata**: Priorities, tags, descriptions, and timestamps
- **Structured sections**: Add steps, constraints, and testing criteria to tasks
- **Code references**: Link tasks to specific source code locations
- **Graph queries**: Find dependency paths, detect cycles, show blocker trees
- **Local storage**: Embedded SurrealDB with RocksDB backend (no server needed)

## Installation

```bash
# Clone the repository
git clone https://github.com/CamonZ/vertebrae.git
cd vertebrae

# Build and install
cargo install --path .
```

## Quick Start

```bash
# Create an epic
vtb add "User Authentication" -l epic -d "Implement user auth system"

# Add tickets under the epic
vtb add "JWT Service" -l ticket --parent <epic-id>
vtb add "Login UI" -l ticket --parent <epic-id>

# Add tasks to a ticket
vtb add "Create token signing" --parent <ticket-id>
vtb add "Add token validation" --parent <ticket-id>

# Set dependencies
vtb depend <validation-task> --on <signing-task>

# Work on tasks
vtb start <task-id>    # Mark as in_progress
vtb done <task-id>     # Mark as done (shows unblocked tasks)

# View tasks
vtb list                        # All active tasks
vtb list -l epic                # Only epics
vtb list --status in_progress   # Tasks being worked on
vtb show <task-id>              # Full task details
vtb blockers <task-id>          # Show dependency tree
```

## Commands

| Command | Description |
|---------|-------------|
| `add` | Create a new task |
| `list` | List tasks with filters |
| `show` | Show full task details |
| `update` | Update task fields |
| `delete` | Delete a task (with optional cascade) |
| `start` | Begin working on a task |
| `done` | Mark task as complete |
| `block` | Mark task as blocked |
| `depend` | Create dependency between tasks |
| `undepend` | Remove dependency |
| `blockers` | Show blocking task tree |
| `path` | Find dependency path between tasks |
| `section` | Add structured content (step, constraint, testing_criterion) |
| `sections` | List task sections |
| `unsection` | Remove sections |
| `ref` | Add code reference |
| `refs` | List code references |
| `unref` | Remove code references |
| `step-done` | Mark a step as completed |

## Task Hierarchy

```
epic           Large initiative spanning multiple deliverables
  └── ticket   Shippable feature or fix
        └── task      Individual unit of work
```

## Task States

```
pending ──────► in_progress ──────► done
    │               │
    └───► blocked ◄─┘
```

## Structured Sections

Add implementation details to tasks:

```bash
# Add implementation steps
vtb section <task-id> step "Set up database schema"
vtb section <task-id> step "Implement CRUD operations"

# Add constraints
vtb section <task-id> constraint "Must support PostgreSQL 14+"

# Add testing criteria
vtb section <task-id> testing_criterion "All endpoints return JSON"

# Mark steps as done
vtb step-done <task-id> 1
```

## Code References

Link tasks to source code:

```bash
# Add reference
vtb ref <task-id> "src/auth/jwt.rs:42" --name "sign_token"

# List references
vtb refs <task-id>

# Remove reference
vtb unref <task-id> "src/auth/jwt.rs:42"
```

## Configuration

The database is stored locally in `.vtb/data/` within your project directory. You can override this with:

```bash
# Via command-line flag
vtb --db /path/to/db list

# Via environment variable
export VTB_DB_PATH=/path/to/db
vtb list
```

## Development

```bash
# Build
cargo build

# Run tests
cargo test

# Run with coverage
cargo llvm-cov

# Format code
cargo fmt

# Lint
cargo clippy -- -D warnings
```

## Project Structure

```
vertebrae/
├── src/
│   ├── main.rs          # CLI entry point
│   └── commands/        # Command implementations
├── crates/
│   └── db/              # Database crate (vertebrae-db)
│       └── src/
│           ├── lib.rs
│           ├── error.rs
│           ├── models.rs
│           ├── schema.rs
│           └── repository/
│               ├── task.rs        # TaskRepository
│               ├── relationship.rs # RelationshipRepository
│               ├── graph.rs       # GraphQueries
│               └── filter.rs      # TaskFilter, TaskLister
└── docs/
    └── tickets/         # Feature specifications
```

## License

MIT
