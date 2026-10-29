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

### Property tests

Invariant-style tests use [Hegel](https://hegel.dev) (`hegeltest`, a dev-dependency of the GUI crate), for example `recorder/properties.rs` in the worktree-delta recorder. They need Rust 1.86+ and build the Hegel engine through a nested `cargo` run, so the first build needs network access to crates.io. Hegel writes its failure database to `.hegel/` next to the crate (gitignored). `scripts/validate.sh rust` runs them with `cargo test -p gui --lib local_chat::worktree_delta`; the GUI crate is excluded from workspace coverage.

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

`crates/daemon-acceptance/tests/features/credential_renewal.feature` (tag
`@credential_renewal`) covers automatic reconnect-credential renewal with the
daemon's default configuration. It shortens only the persisted `expires_at`
in `daemon.toml`, and covers renewal, restart reuse, an expired credential, and
recovery from owner rotation through `vtb-daemon enroll --replace-existing`. The
Sacrum image must include the `renewDaemonCredential` mutation (Sacrum PR 253).
Run only these scenarios with
`CUCUMBER_FILTER_TAGS=@credential_renewal` set on `daemon-test-runner`.

### Rhai execute demo

`crates/daemon-acceptance/tests/features/execute.feature` creates disposable
fixtures for a deterministic inference producer, a real Rhai transform,
a JSON consumer, and a terminal finish. Execute steps are created through
`vtb step add --step-type execute` with inline and `@file` scripts, without a
harness. The transform script is then updated through
`vtb step update --script @file`, and definition reads verify the retained schema and absent runtime
context before the run. The isolated Sacrum image must contain
the merged Sacrum PR 235 context/GraphQL/render/dispatch contract; an older image cannot run
these scenarios. Both `sacrum` and `seeder` must use that same companion image.
Run only these scenarios with a Compose environment override setting
`CUCUMBER_FILTER_TAGS=@execute` on `daemon-test-runner`, or run the whole suite
with the command above. Use a unique Compose project name and tear down its
containers and volumes after the run.

The producer persists `{"name":"example","quantity":3,"unit_price":12}`.
The transform is authored with this config, without a harness:

```json
{
  "version": 1,
  "script": "#{ name: execution.previous_output.name, total: execution.previous_output.quantity * execution.previous_output.unit_price }",
  "output_schema": {
    "type": "object",
    "properties": {"name": {"type": "string"}, "total": {"type": "number"}},
    "required": ["name", "total"],
    "additionalProperties": false
  }
}
```

Its output is `{"name":"example","total":36}`. The consumer reads
`steps.transform.output.total` and validates a numeric `observed_total`. It also
returns all six namespace bindings and compares them with its persisted
`config.context`, proving the full server snapshot reaches the Rhai scope. A second example changes quantity to 4 and asserts total 48.
The tests also inspect resolved execution snapshots, common TaskRun identity,
absence of inference metadata, and evaluation/schema failures. Existing
provider mock scenarios use `llm_inference`; they do not prove Rhai execution.

`execute_rollup.feature` runs the child-outcome rollup sample from
`docs/agent-context/workflows/steps/execute/host-reads.md`. The step definitions
embed that doc and take the first `rhai` and `json` blocks as the script and
output schema, so editing the sample changes what the scenarios run.

`execute_task_writes.feature` covers `vtb::tasks::create`, `update`, `archive`
and `unarchive`, including other-project targets and refused patch keys.
`execute_plan_children.feature` runs the plan-children sample from
`docs/agent-context/workflows/steps/execute/host-writes.md` the same way: the
first `json` block is the plan, the first `rhai` block the script, and the
`--output-schema` value the schema.

`execute_task_edits.feature` covers the section, checklist, code-ref, parent
and dependency edits on existing and newly created tasks, reruns, ordinals
that survive an earlier section's removal, cycles and other-project targets.
It runs the checklist sample from
`docs/agent-context/workflows/steps/execute/host-edits.md` (its first `rhai`
block) twice in one script.

`execute_artifact_writes.feature` covers `vtb::artifacts::put` and `put_json`
creating and replacing artifacts on the script's task, another task and the
project, their stored bodies, filenames and provenance, a retried attempt that
converges, output persistence overwriting a `put` to the same name, and
other-project targets. It runs the progress sample from
`docs/agent-context/workflows/steps/execute/host-artifact-writes.md` (its
first `rhai` block) twice in one script.

`execute_deletes.feature` covers `vtb::tasks::delete` with and without cascade
and `vtb::artifacts::delete` on a task and the project, reruns that treat
`not_found` as done, refusals for the running task, another task's active
TaskRun and a cascade that reaches either, artifacts that outlive their task,
and other-project targets. It runs the scratch-children sample from
`docs/agent-context/workflows/steps/execute/host-deletes.md` (its first `rhai`
block).

`execute_notifications.feature` covers `vtb::notifications::send` and
`escape`: messages stored byte for byte with escaped link labels, the default
severity, separate notifications for identical sends, history paged one at a
time, marking read (idempotent, keeping the first read time), invalid
arguments that publish nothing, and an uncaught error failing the step. It
runs the report sample from
`docs/agent-context/workflows/steps/execute/host-notifications.md` (its first
`rhai` block) and checks the stored message links the artifact and task.

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
- `next_file` (string, optional) — written by `MockResponse::followed_by`: the
  envelope played the next time the same prompt is delivered (a step that runs
  again in one TaskRun receives the same prompt). The last envelope in the chain
  repeats. Deliveries are counted in the scenario's `MOCK_CAPTURE_DIR`.
- `discard_session` (bool, optional) — written by
  `MockResponse::with_discarded_session`: the provider forgets this turn's
  conversation afterwards. A later Claude launch resuming or forking it prints
  `No conversation found with session ID: <id>`, emits an
  `error_during_execution` result and exits 1 before reading a turn; Codex
  answers `thread/resume`/`thread/fork` with `-32600 no rollout found for
  thread id <id>`.

In persistent stream-json sessions mock-claude rewrites each fixture record's
`session_id` to the launch's conversation (`--session-id`, else the `--resume`
target), as Claude echoes it, and appends every argv to
`MOCK_CAPTURE_DIR/invocations.jsonl`. mock-codex gives each `thread/start` a
distinct thread id and rejects resuming or forking a thread it did not create.
`route_sessions.feature` uses these to prove route-driven new, resume and
rejected-resume conversations on both harnesses, including a resume across an
`inter_workflow` route and its failure into a non-`llm_inference` step, and
`transition_sessions.feature` proves that a step entered over a resume edge
(`--transition-session`) continues the previous step's conversation, also past
a stop step from the run that stopped there (and fails when that run has no
turn). `parent_child.feature` proves that `--children-session` children fork
the parent's conversation while the parent resumes its own, and that a child
whose entry step is not `llm_inference` fails. These scenarios assert the
provider launch (`--resume`/`--fork-session`, `thread/resume`/`thread/fork`)
and the lineage Sacrum records (`resume_session_id`,
`conversation_root_execution_id`, `forked_from_execution_id`). The failure
scenarios assert `dispatch_failed` and the step id in `outcome_context.reason`;
Sacrum keeps the error code (`session_requires_llm_inference`,
`session_not_found`) in its log only, so they cannot tell the two apart.

Fixture files live under `crates/daemon-acceptance/mocks/` and are mounted at
`/mocks/` inside the container. Per-scenario isolation requires unique fixture
filenames: `<feature>__<scenario_slug>__<step>.{stdout,stderr}.jsonl`.

**Liquid template caveat.** Sacrum runs a Liquid template pass over
`payload.prompt`, triggered by `{{`, `}}`, `{%`, and `%}` sequences. The
`MockResponse` builder rejects envelopes whose string values contain any of
those sequences so the scripted prompt arrives at the daemon intact. Bare `{`
or `}` from normal JSON nesting are safe.

### CI Postgres image cache

The acceptance workflow caches a `docker save` archive of Postgres between
GitHub-hosted jobs. Its key includes the pinned source image digest, runner OS
and architecture. A hit loads the archive; a miss pulls the pinned image and
saves it before tests start. An unreadable archive falls back to pulling.

CI tags the image as `vtb-acceptance-postgres:ci` and passes it through
`VTB_ACCEPTANCE_POSTGRES_IMAGE` to Compose because image archives retain tags,
not registry digest references. Local runs keep the existing ECR image default.
Update `POSTGRES_IMAGE_SOURCE` in `.github/workflows/acceptance.yml` to refresh
Postgres and invalidate the cache. This caches the image only: test containers
and database volumes are still disposed after each run. Compare the cache
restore/load timings with pulls in CI to verify the benefit.

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

For GUI-driven project setup against the local Colima engine, run:

```bash
python3 scripts/acceptance-colima.py
```

The opt-in lane runs the actual Linux Tauri UI with WebDriver and the native
GTK folder chooser against the host Colima Docker socket. It uses a disposable
app home and a unique managed database. It clicks backend selection, runtime
selection, Refresh, folder selection, project creation and entry into the app.
It never invokes setup/project commands directly. Component binaries and mock
AI executables are fixture prerequisites; backend configuration and projects
start absent. This does not verify the macOS WebView or component installer.
Screenshots/logs are retained under `test-output/colima-*`. Only test-owned
containers and the database volume are removed; build caches are retained.

The `Colima GUI project setup` job in `.github/workflows/acceptance.yml` runs
this same scenario on PRs targeting master, master pushes and manual runs.
On an Ubuntu 24.04 runner it starts a real Colima QEMU VM accelerated by KVM
with pinned Colima and Lima versions, then invokes the same runner; it does
not substitute the host's Docker engine. CI supplies
`VTB_ACCEPTANCE_OUTPUT=test-output/colima` for artifact collection. The runner
cleans up its stack, and an always-run job step deletes the disposable Colima
VM and its data even after a test failure. This validates the Linux webview
against Colima, not the native macOS webview or first-install component flow.

The local-backend Docker smoke tests are ignored by default because they pull an
actual GHCR Sacrum image and create temporary Docker resources. Run them only in
an isolated Docker environment. They resolve the latest published backend from
the `backend-master/latest.json` manifest, just like fresh setup. Supply a distinct
official digest-pinned image for the update portion:

```bash
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

### GUI-managed Podman acceptance scenarios

The GUI acceptance runner includes a separate `@podman` phase using a real
Podman 5.6.2 engine and podman-compose 1.5.0. The final runner image contains
neither `docker` nor `docker-compose`; image build and entrypoint checks assert
their absence on disk. It starts
the GUI as a dedicated UID 1000 user with its own HOME, rootless storage and API
socket. No host container-engine socket is mounted. The disposable outer runner
is privileged to allow nested user namespaces; the test user retains SYS_ADMIN
inside that container for kernels that restrict unprivileged namespace creation.
The nested engine uses VFS storage and disabled cgroups. Without a systemd user
manager, a runner loop executes `podman healthcheck run` against the containers'
actual configured checks. This lane does not validate health-check scheduling by
a desktop service manager, desktop storage drivers, SELinux, macOS VM forwarding
or host restarts.

```bash
python3 scripts/acceptance.py gui
# Run just the Podman phase while iterating:
GUI_ACCEPTANCE_PODMAN_ONLY=1 python3 scripts/acceptance.py gui
```

`local_backend_podman.feature` invokes real Tauri commands to provision a stack,
authenticate with saved GUI settings, restart the application, and reopen the saved
installation. It checks loopback reachability and refusal of non-loopback TCP
ingress. A combined setup scenario provisions a fresh self-hosted backend,
creates and selects a project through the real GUI commands, verifies the project
exists in that backend, and checks it remains active after restarting the GUI.
Other scenarios cover saved identity, database/token preservation, cross-runtime refusal,
changed-storage refusal, missing-volume refusal without recreation, and refusal
to silently replace a missing legacy Docker Compose provider. A separate scenario
checks that fresh setup installed the latest manifest image and release metadata,
and that an already-current update is refused without changing containers or data. Poisoned
inherited engine/provider variables exercise explicit target selection. Engine
metadata, provider version and API/driver logs are saved under the run's
`podman/` output directory. Actual replacement between distinct image digests is
covered by the opt-in Docker and Podman smoke tests below.

### GUI-managed Podman smoke test

The adapter targets the configurations below. The Docker-hosted acceptance lane
verifies a real Linux rootless engine/provider pair; desktop and macOS machine
verification remain pending. Run and record the smoke test on each platform
before claiming desktop, VM forwarding, SELinux or restart compatibility.

| Configuration | Prerequisites | Current evidence |
|---|---|---|
| Linux rootless in isolated acceptance container | Podman 5.6.2, podman-compose 1.5.0, Linux arm64 | Seven real GUI scenarios / 51 steps passed, including fresh backend/project setup and latest-release verification; VFS, disabled cgroups, runner-scheduled health checks |
| Linux rootless, previous Docker Compose lane | Podman 5.6.2, standalone Docker Compose 2.26.1-4, Linux arm64 | Four real GUI scenarios passed in PR #501; retained compatibility unit tests |
| Linux native desktop rootless | Podman 5.6+, running user API socket, podman-compose 1.5+ or standalone Docker Compose 2.24+ | Mocked target/command/lifecycle tests; native-host smoke pending |
| macOS rootless machine | Podman 5.6+, running registered machine, rootless connection and shared app-data directory, podman-compose 1.5+ or standalone Docker Compose 2.24+ | Mocked machine/connection/restart-identity tests; real smoke pending |
| Windows or rootful Podman | Outside this integration | Rejected by runtime validation |

Version checks cover podman-compose 1.5+ and standalone Docker Compose 2.24+.
Saved installations keep their provider path and kind; omitted kind in older
schema-2 state means Docker Compose. Missing providers require restoring the
saved executable rather than automatically switching implementations.
Record additional tested engine/provider pairs in the table. The GUI only discovers
installed tools. Setup then validates the engine, saved connection and provider.
A stopped socket/machine requires the user to start it; a changed saved machine
identity (including SSH forwarding/connection details) is rejected rather than
silently retargeted. Test machine/host restarts and record whether the identity
remains stable on the chosen Podman release.

Use an isolated rootless engine/machine. The initial image resolves from the
latest `backend-master/latest.json` manifest; supply a distinct official Sacrum
digest for the update portion:

```bash
VERTEBRAE_TEST_PODMAN=1 \
VERTEBRAE_TEST_NON_LOOPBACK_HOST='<this-host-non-loopback-ip>' \
VERTEBRAE_TEST_SACRUM_UPDATE_IMAGE_REF='<second-official-sacrum-digest>' \
cargo test -p gui --lib podman_smoke_provision_reopen_update_and_volume_preservation \
  -- --ignored --nocapture
```

This opt-in test creates a unique Compose project and app-data directory under
HOME (so it can be shared with the macOS machine), provisions PostgreSQL/Sacrum,
checks logical replication, seeds/authenticates, reopens using saved identity,
updates Sacrum, verifies a database sentinel/token/volume survive, and checks
loopback container bindings, refusal of TCP ingress on the supplied non-loopback
host interface, and log redaction. It cleans up only its own project
and database volume and does not write the user's client configuration.
Ordinary tests use fake runners and temporary paths and never start Podman.

Real-platform verification must also confirm **host** loopback reachability and
rejection of non-loopback ingress (including macOS VM forwarding), SELinux and
shared-file access, restart persistence, missing/foreign-volume refusal, and
Docker/Podman coexistence. Container inspection alone cannot prove host/VM
network isolation. Defaults, SSH machine fields and JSON formats follow the
current [machine inspection](https://docs.podman.io/en/stable/markdown/podman-machine-inspect.1.html)
and [info](https://docs.podman.io/en/stable/markdown/podman-info.1.html)
contracts, which still require real-platform verification.

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
Local cache identity derives from the checkout path; GitHub-hosted CI supplies
the run ID and attempt through `VTB_ACCEPTANCE_CACHE_KEY`. CI build caches last
for that disposable job. The runner prints the resolved cache name.
To benchmark an empty cache, supply a new key; reuse that key for warm runs.
Only remove these named cache volumes when no run is using them.

Runner images contain only system packages and tools; the checkout is mounted
and compiled inside the container, so feature files and acceptance crates never
require an image rebuild. Each image is tagged
`ghcr.io/camonz/vtb-acceptance-<suite>:<Dockerfile digest>`. The runner uses a
local copy, then pulls the published tag for the Docker host's platform, and
builds locally only when neither exists. Published images are amd64, matching
the CI runners, so other hosts build natively.
`.github/workflows/acceptance-images.yml` publishes new digests from `master`
and from PRs that change image inputs with
`python3 scripts/acceptance.py --publish-images`; later runs pull them. Set
`VTB_ACCEPTANCE_REGISTRY` to use another registry. If a Dockerfile starts to
`COPY` files, include them in `image_ref()` in `scripts/acceptance.py`.

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
