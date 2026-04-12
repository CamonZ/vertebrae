# Testing

## Rust Tests

### Unit and Integration Tests

```bash
# Run all workspace tests (excludes acceptance test crates)
cargo test --quiet --workspace --exclude acceptance --exclude gui-acceptance

# Run tests with output visible
cargo test --workspace --exclude acceptance --exclude gui-acceptance -- --nocapture

# Run tests for a specific crate
cargo test --quiet -p vertebrae-core
cargo test --quiet -p vertebrae-cli
```

### Code Coverage

Requires `cargo-llvm-cov` (`cargo install cargo-llvm-cov`).

```bash
# Run tests with coverage report
cargo llvm-cov --quiet --workspace --exclude acceptance --exclude gui-acceptance

# Run with coverage threshold check (75% minimum, used in CI/pre-commit)
cargo llvm-cov --quiet --workspace --exclude acceptance --exclude gui-acceptance --fail-under-lines 75
```

Note: `llvm-cov` runs tests internally — no need to run `cargo test` separately.

### Acceptance Tests

Acceptance tests live in `crates/acceptance` and `crates/gui-acceptance`. They require a live Sacrum backend and run inside Docker only.

**Do NOT run acceptance tests locally** — they need a running Sacrum instance and would pollute the local database.

Acceptance tests shell out to the `vtb` binary (they don't call the service layer directly).

## GUI Tests (React)

```bash
cd crates/gui

# Run tests once
npm run test

# Run tests in watch mode
npm run test:watch

# Run tests with coverage report
npm run test:coverage
```

## Linting and Formatting

```bash
# Format code
cargo fmt

# Check formatting without modifying files
cargo fmt --check

# Run clippy linter (quiet mode)
cargo clippy --quiet

# Run clippy treating warnings as errors (used in CI/pre-commit)
cargo clippy --quiet -- -D warnings
```

## Pre-commit Hook

The git pre-commit hook runs all quality checks automatically. See [Git Hooks](git-hooks.md) for setup.

Checks run in order:

1. `cargo fmt --check` — formatting
2. `cargo clippy --quiet -- -D warnings` — linting
3. `cargo llvm-cov --quiet --workspace --exclude acceptance --exclude gui-acceptance --fail-under-lines 75` — tests + coverage >= 75%
4. `npm run test` (in `crates/gui`) — React tests
