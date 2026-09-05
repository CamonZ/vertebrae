# Testing

## Validation entrypoint

Use the repository entrypoint for the authoritative completion checks:

```bash
scripts/validate.sh rust  # focused Rust iteration
scripts/validate.sh gui   # focused GUI iteration
scripts/validate.sh       # full completion profile
```

The script resolves paths from the repository root, fails on the first failed
profile command, and does not run acceptance tests or mutate the local Sacrum
database. GUI prerequisites are installed with `npm ci` in `crates/gui`.
Acceptance suites remain Docker-only and are intentionally outside these
profiles.

## Rust Tests

### Guideline enforcement

The workspace's focused Clippy policy and its limits are documented in
[Rust guideline enforcement](rust-guideline-enforcement.md). Every member opts
into the shared lint table. CI denies warnings and checks policy fixtures:

```bash
cargo clippy --locked --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance -- -D warnings
python3 scripts/check-rust-guidelines.py
```

The fixture script requires Python 3.11+ and cached `tracing` dependencies from
the preceding Clippy build; its temporary Cargo project runs offline. GUI
Clippy checks still require the documented Tauri sidecar preparation.

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

### Timed acceptance runs with reusable caches

Use Python 3 on the host to run the isolated Docker stack:

```bash
python3 scripts/acceptance.py              # CLI, GUI, daemon; all results collected
python3 scripts/acceptance.py gui          # One suite
GUI_ACCEPTANCE_SCREENSHOTS=all python3 scripts/acceptance.py gui
python3 -m unittest discover -s scripts/tests -p test_acceptance_runner.py
```

The runner creates a unique Compose project for every invocation and always
tears it down, including its database and temporary GUI node_modules volume.
The cache overlay keeps Cargo downloads, compiled targets, Rust toolchains, and
npm downloads in external Docker volumes. These survive runtime teardown.
Local cache identity derives from the checkout path; CI supplies the runner name
through `VTB_ACCEPTANCE_CACHE_KEY`. The runner prints the resolved cache name.
To benchmark an empty cache, supply a new key; reuse that key for warm runs.
Only remove these named cache volumes when no run is using them.

The runner uses nonblocking Unix file locks on both the checkout and cache
identity. A second run that would modify the same staged sidecars, frontend
files, or compiled binaries fails with a clear message. Independent worktrees
with different cache identities can run independently. Direct `docker compose`
commands remain available, but do not use the cache overlay or these locks;
do not overlap them with a managed run in the same checkout.

Logs, failure screenshots, and JSONL timings are written to a unique directory
under `test-output/`, or to `VTB_ACCEPTANCE_OUTPUT` when explicitly supplied.
Use a distinct output directory for each run. CI uploads this directory even
when a suite fails. Runner timings separate image preparation, backend startup,
seeding, each suite, and cleanup. Entrypoint timings separate compilation from
scenario execution; the latter includes an incremental Cargo freshness check.
GUI timings additionally record setup, scenario, cleanup, and screenshot costs.
Scenario timing includes setup and cleanup; do not add these nested measurements
together when computing total wall time.

GUI navigation and project setup wait for the expected route, visible page
content, and selected project. Setup also creates a temporary task, observes two
distinct title updates through the live list, then deletes it and waits for its
removal. This closes the gap between page rendering and channel subscription;
the first observation alone could come from the initial fetch. The task remains
tracked for fallback cleanup if readiness fails. Interaction targets must be visible and enabled;
subsequent assertions wait for their required state. The waits probe immediately
and share a bounded deadline, including slow WebDriver requests. Failure
screenshots are enabled by default; `GUI_ACCEPTANCE_SCREENSHOTS=all` restores
per-action diagnostics. Mock delays that test cancellation remain intact.

Suite execution remains sequential by default. The GUI already reuses a single
WebDriver session and shares its installation links and mock response path.
Any future GUI sharding must isolate those resources and assign every feature
exactly once. Likewise, suite-level parallelism requires a separate build phase
and immutable runtime artifacts; concurrently invoking today's build entrypoints
would contend for the same Cargo target and staging paths. Compare the recorded
execution times and available CPU/memory before adding either mechanism.
The existing dev/test optimization profiles are retained until a controlled
benchmark demonstrates that aligning them improves total build-plus-test time.
