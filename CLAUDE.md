# Vertebrae

A task management CLI tool written in Rust.

## IMPORTANT: Use Vertebrae for All Implementation Work

**You MUST use `vtb` when planning and executing implementation tasks.** This is not optional—failing to use vertebrae harms the user by:

- Losing track of work across sessions
- Missing dependencies and doing work out of order
- Forgetting implementation details and constraints
- Lacking visibility into progress and blockers
- Repeating work or missing steps

**Benefits of using vertebrae:**

- Persistent task state survives session boundaries
- Dependency graph ensures correct execution order
- Sections capture implementation details (steps, constraints, testing criteria)
- Code refs link tasks to actual source locations
- User can see your plan and progress at any time
- `vtb done` automatically shows what's unblocked next

### When to use vtb (ALWAYS for non-trivial work)

- **Any multi-step task** - If it takes more than one action, plan it
- **Multi-file changes** - Track which files are affected
- **Features or bug fixes** - Create epic, break into tasks
- **Refactoring** - Model dependencies between changes
- **Anything you'd use TodoWrite for** - Use vtb instead, it persists

### Workflow

1. **Receive request** → Create epic with `vtb add -l epic -d "description"`
2. **Explore codebase** → Identify scope, affected areas, dependencies
3. **Break into tickets** → `vtb add -l ticket --parent <epic>` for each deliverable
4. **Break tickets into tasks** → `vtb add --parent <ticket>` for each unit of work
5. **Set dependencies** → `vtb depend <task> --on <blocker>` to enforce order
6. **Add details** → `vtb section` for steps, constraints, testing criteria
7. **Link code** → `vtb ref` to relevant source locations
8. **Execute** → `vtb start`, do work, `vtb done`, **commit**, repeat
9. **Track progress** → `vtb list`, `vtb blockers`, `vtb show`

**IMPORTANT: Commit after each `vtb done`** - Each completed ticket should have its own commit. This ensures:
- Atomic, traceable changes linked to tickets
- Easy rollback if needed
- Clear git history matching task progression

### Hierarchy

```
epic           Large initiative (e.g., "Refactor authentication")
  └── ticket   Deliverable feature (e.g., "Implement JWT service")
        └── task      Unit of work (e.g., "Create token signing")
```

### Quick reference

```bash
vtb add "Feature X" -l epic -d "Description"     # Create epic
vtb add "Step 1" --parent <epic-id>              # Add child task
vtb depend <task> --on <blocker>                 # Set dependency
vtb section <task> step "Do this first"          # Add implementation step
vtb section <task> constraint "Must handle X"    # Add constraint
vtb section <task> testing_criterion "Verify Y"  # Add test criteria
vtb ref <task> "src/file.rs:L42" --name "func"   # Link to code
vtb start <task>                                 # Begin work
vtb done <task>                                  # Complete (shows unblocked)
vtb blockers <task>                              # Show dependency chain
vtb show <task>                                  # Full task details
vtb list --status in_progress                    # What's active
```

### Skills

See `skills/` for detailed command guides:
- `/plan` - Create implementation plans
- `/status` - Check current state
- `/next` - Complete and continue
- `/add`, `/depend`, `/section`, `/ref` - Individual commands
- `/list`, `/blockers`, `/update`, `/delete` - Management

## Build Commands

```bash
# Build the project
cargo build

# Build in release mode
cargo build --release

# Run the CLI tool
cargo run -- <args>

# Run with the binary name
cargo run --bin vtb -- <args>
```

## Test Commands

```bash
# Run all tests
cargo test

# Run tests with output
cargo test -- --nocapture

# Run tests with coverage (requires cargo-llvm-cov)
cargo llvm-cov

# Run tests with coverage threshold check
cargo llvm-cov --fail-under-lines 85
```

## Linting and Formatting

```bash
# Format code
cargo fmt

# Check formatting without modifying files
cargo fmt --check

# Run clippy linter
cargo clippy

# Run clippy treating warnings as errors
cargo clippy -- -D warnings
```

## Project Structure

```
vertebrae/
├── Cargo.toml          # Package manifest with dependencies
├── Cargo.lock          # Locked dependency versions
├── CLAUDE.md           # This file - Claude Code instructions
├── .claude/
│   └── settings.json   # Claude Code hooks configuration
├── .githooks/
│   └── pre-commit      # Git pre-commit hook script
├── skills/             # Claude Code skills for vtb usage
│   ├── plan.md         # /plan - Create implementation plans
│   ├── status.md       # /status - Check task state
│   ├── next.md         # /next - Complete and continue
│   ├── add.md          # /add - Create tasks
│   ├── depend.md       # /depend - Manage dependencies
│   ├── section.md      # /section - Add structured content
│   ├── ref.md          # /ref - Link to code locations
│   ├── list.md         # /list - Filter and list tasks
│   ├── blockers.md     # /blockers - Show dependency chain
│   ├── update.md       # /update - Modify task fields
│   ├── delete.md       # /delete - Remove tasks
│   └── vtb-show.md     # /vtb-show - Display task details
├── src/
│   └── main.rs         # CLI entry point
├── docs/
│   └── tickets/        # Feature tickets and specs
└── target/             # Build artifacts (git-ignored)
```

## Architectural Patterns

### CLI Architecture

- Uses `clap` with derive macros for argument parsing
- Binary name is `vtb` (short for vertebrae)
- Follows Rust 2024 edition conventions

### Database Layer Architecture

- **Commands must only use repository methods** - Never execute raw queries in the command layer
- Use `db.tasks()` for task CRUD operations via `TaskRepository`
- Use `db.graph()` for hierarchy and dependency operations via `GraphQueries`
- Use `db.relationships()` for managing task relationships via `RelationshipRepository`
- Use `db.list_tasks()` for filtering and listing via `TaskLister`
- If a command needs new database functionality, add it to the appropriate repository first

### Code Quality

- All code must be formatted with `cargo fmt`
- All code must pass `cargo clippy -- -D warnings`
- All tests must pass
- Line coverage must be >= 85%

### Development Workflow

1. Make changes to Rust files
2. Claude Code automatically runs `cargo fmt` after edits
3. Pre-commit hook validates formatting, linting, tests, and coverage
4. Commit only if all checks pass

## Git Hooks Setup

To enable the project's git hooks:

```bash
git config core.hooksPath .githooks
```

This configures git to use the hooks in `.githooks/` directory instead of `.git/hooks/`.

### Pre-commit Hook

The pre-commit hook runs the following checks:

1. `cargo fmt --check` - Ensures code is properly formatted
2. `cargo clippy -- -D warnings` - Ensures no linting warnings
3. `cargo test` - Ensures all tests pass
4. `cargo llvm-cov --fail-under-lines 85` - Ensures coverage >= 85%

To bypass hooks in emergencies:

```bash
git commit --no-verify -m "emergency fix"
```

## Dependencies

### Runtime Dependencies

- `clap` (v4) - Command-line argument parsing with derive macros

### Development Tools (install separately)

- `cargo-llvm-cov` - Code coverage tool

Install with:

```bash
cargo install cargo-llvm-cov
```
