# Git Hooks

## Setup

Run the setup script to configure git hooks and install dependencies:

```bash
./scripts/setup.sh
```

This script:
- Configures git to use the hooks in `.githooks/`
- Installs GUI npm dependencies (required for pre-commit tests)
- Verifies Rust toolchain and `cargo-llvm-cov`

### Manual Setup

```bash
git config core.hooksPath .githooks
cd crates/gui && npm install
```

## Pre-commit Hook

The `.githooks/pre-commit` script runs these checks:

**Rust:**
1. `cargo fmt --check` — code formatting
2. `cargo clippy --quiet -- -D warnings` — no linting warnings
3. `cargo llvm-cov --quiet --workspace --exclude acceptance --exclude gui-acceptance --fail-under-lines 75` — tests pass with >= 75% line coverage

**GUI (React):**
4. `npm run test` (in `crates/gui`) — all React/TypeScript tests pass

## Bypassing Hooks

In emergencies only:

```bash
git commit --no-verify -m "emergency fix"
```
