# Testing

## Rust Tests

### Unit and Integration Tests

```bash
# Run all workspace tests (excludes acceptance test crates)
cargo test --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance

# Run tests with output visible
cargo test --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance -- --nocapture

# Run tests for a specific crate
cargo test --quiet -p vertebrae-core
cargo test --quiet -p vertebrae-cli
```

### Code Coverage

Requires `cargo-llvm-cov` (`cargo install cargo-llvm-cov`).

```bash
# Run tests with coverage report
cargo llvm-cov --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance

# Run with coverage threshold check (75% minimum, used in CI/pre-commit)
cargo llvm-cov --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance --fail-under-lines 75
```

Note: `llvm-cov` runs tests internally — no need to run `cargo test` separately.

### Acceptance Tests

Acceptance tests live in `crates/acceptance`, `crates/gui-acceptance`, and `crates/daemon-acceptance`. They require a live Sacrum backend and run inside Docker only.

**Do NOT run acceptance tests locally** — they need a running Sacrum instance and would pollute the local database.

Acceptance tests shell out to the `vtb` binary (they don't call the service layer directly).

#### Daemon Acceptance Tests

The daemon acceptance suite exercises `vtb-daemon` end-to-end: Sacrum broadcasts
`run_step`, the daemon spawns a child `claude` process, streams output back, and
reports completion/failure. A mock claude binary replaces the real Claude Code
CLI via `CLAUDE_CODE_PATH=/usr/local/bin/mock-claude` — the daemon code path
under test is unchanged.

```bash
docker compose run --rm daemon-test-runner
```

**Mock prompt-as-JSON envelope.** The step's `prompt` is parsed by the mock as a
JSON envelope with this schema:

```json
{
  "exit_code": 0,
  "delay_ms": 0,
  "stdout_file": "happy_path__completed__step1.stdout.jsonl",
  "stderr_file": null
}
```

- `exit_code` (int) — exit code the mock returns after emitting output.
- `delay_ms` (int) — milliseconds to sleep before exiting (used by the cancel
  scenario). Sleep is interruptible so SIGKILL kills the mock promptly.
- `stdout_file` / `stderr_file` (string|null) — paths (relative to
  `MOCK_OUTPUT_DIR`, which is `/mocks/` in the container) to fixture files whose
  contents are emitted verbatim to stdout/stderr. Absolute paths and `..`
  components are rejected.

Fixture files live under `crates/daemon-acceptance/mocks/` and are mounted at
`/mocks/` inside the container. Per-scenario isolation requires unique fixture
filenames: `<feature>__<scenario_slug>__<step>.{stdout,stderr}.jsonl`.

**Liquid template caveat.** Sacrum runs a Liquid template pass over
`payload.prompt`, triggered by `{{`, `}}`, `{%`, and `%}` sequences. The
`MockResponse` builder rejects envelopes whose string values contain any of
those sequences so the scripted prompt arrives at the daemon intact. Bare `{`
or `}` from normal JSON nesting are safe.

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

### GUI-managed Docker smoke tests

The local-backend Docker smoke tests are ignored by default because they pull an
actual GHCR Sacrum image and create temporary Docker resources. Run them only in
an isolated Docker environment with official digest-pinned image references:

```bash
VERTEBRAE_TEST_SACRUM_IMAGE_REF='<official-sacrum-digest>' \
VERTEBRAE_TEST_SACRUM_UPDATE_IMAGE_REF='<second-official-sacrum-digest>' \
cargo test -p gui --lib docker_smoke_fresh_stack_covers_provisioning_persistence_and_updates \
  -- --ignored --nocapture
```

This verifies PostgreSQL 18 logical replication, migrations, `/healthz`, generated
secrets and token seeding, log redaction, controller restart persistence, and an
approved Sacrum image update without database recreation. A separate Unix-only
adoption smoke test exercises the legacy `scripts/dev-backend.sh` contract. It
requires the explicit opt-in below, starts only when no `vertebrae-dev` stack or
volume already exists, and destroys the test-created legacy volume when complete:

```bash
VERTEBRAE_TEST_ALLOW_LEGACY_STACK=1 \
VERTEBRAE_TEST_SACRUM_IMAGE_REF='<official-sacrum-digest>' \
cargo test -p gui --lib docker_smoke_adopts_dev_backend_without_reseeding_or_replacing_v17_volume \
  -- --ignored --nocapture
```

The default Rust and GUI test suites do not require Docker for local-backend
adoption. Unit and component tests use temporary application-data paths and
mocked Docker runners; they must not write the user's shared `config.toml`,
start or remove containers, or delete/replace volumes. The ignored adoption
smoke test is the only adoption-specific test that creates Docker resources,
and it is opt-in, requires an isolated Docker environment, and cleans up only
resources it created.

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
3. `cargo llvm-cov --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance --fail-under-lines 75` — tests + coverage >= 75%
4. `npm run test` (in `crates/gui`) — React tests
