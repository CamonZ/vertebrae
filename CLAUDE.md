# Vertebrae

A task management CLI tool written in Rust.

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
