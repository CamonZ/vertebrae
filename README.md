# Vertebrae

Vertebrae is a persistent task management and AI workflow orchestration system. It provides:

- `vtb`, a Rust CLI for humans and coding agents
- a Tauri + React desktop GUI for visual task and workflow operations
- `vtb-daemon`, a background executor that runs workflow steps through Claude Code
- a shared Rust service layer backed by the Sacrum GraphQL API and Phoenix channels

## Documentation

Start with the [documentation index](docs/index.md).

Key entrypoints:

- [Project Overview](docs/project-overview.md) - workspace structure, crates, dependencies, and build commands
- [Architecture](docs/architecture.md) - crate map, service traits, Sacrum GraphQL client, GUI, and daemon
- [System Overview](docs/system-overview.md) - full Vertebrae + Sacrum domain and execution model
- [vtb Guide](docs/vtb-guide.md) - CLI usage for tasks, dependencies, sections, workflows, steps, and runs
- [GUI Development](docs/gui-development.md) - Tauri + React development workflow
- [Testing](docs/testing.md) - local test, lint, coverage, and acceptance-test guidance
- [Sacrum Config](docs/SACRUM_CONFIG.md) - global config file and environment overrides

## Quick Start

```bash
# Build the workspace
cargo build --quiet

# Build the CLI, daemon, gate, and GUI bundle in dependency order
scripts/build-package.sh --release

# Build Linux GUI packages by requesting the bundle format you need
scripts/build-package.sh --release --bundles appimage
scripts/build-package.sh --release --bundles deb
scripts/build-package.sh --release --bundles rpm

# Run local Rust tests, excluding Docker-backed acceptance crates
cargo test --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance

# Run the CLI
target/debug/vtb --help

# Start GUI development
cd crates/gui
npm install
npm run tauri:dev
```

`scripts/build-package.sh` stages the sidecars (`vtb`, `vtb-daemon`, and
`vtb-gate`) before invoking Tauri. On macOS it defaults to a `.app` bundle; pass
`--bundles dmg` when you specifically need Tauri's DMG output. If create-dmg's
Finder layout step fails, the wrapper retries with an unstyled DMG that still
contains the app and Applications link. On Linux, install the Tauri system
dependencies first, then choose `appimage`, `deb`, or `rpm`.
For Debian/Ubuntu:

```bash
sudo apt-get install -y libgtk-3-dev libwebkit2gtk-4.1-dev libayatana-appindicator3-dev librsvg2-dev
```

## Sacrum Backends

`vtb`, the GUI, `vtb-daemon`, and the shared Rust services all consume the same
Sacrum connection fields: `[sacrum].url` and `[sacrum].token` in the global
configuration file. The GUI’s local-backend files are separate application state;
they do not change the configuration format or add Docker metadata to it.

The GUI first-run flow offers two choices:

- **Remote backend**: enter the backend URL and API token. No Docker resources are
  created, and the token is stored only in the normal Sacrum configuration.
- **GUI-managed local backend**: the GUI checks Docker, provisions a fresh local
  stack, and writes the resulting loopback URL/token to the same Sacrum
  configuration. Docker Desktop or a local Docker Engine with Compose is required;
  the managed path requires Engine 28 or newer and a local Unix/npipe Docker
  endpoint.

A fresh managed stack uses the official digest-pinned Sacrum image selected by the
  backend manifest and `postgres:18-alpine` configured for logical replication. It
  runs the Sacrum migrations, waits for `/healthz`, and runs a one-shot seeder with
  an installation-specific account and API token. PostgreSQL credentials and
  `SECRET_KEY_BASE` are stored in the GUI application-data directory with
  owner-only permissions. The API token is cached there and written to
  `config.toml` as the canonical client credential. The generated account is sent
  only to the one-shot seeder. Secrets are not printed in command output.

Managed containers run detached, so closing the GUI does not stop a healthy local
backend. On the next GUI startup, a saved ready state causes the GUI to reconcile
the same Compose project and volume, wait for health, and reuse the saved token. It
does not reseed the account. Approved image updates replace only the Sacrum service;
they do not rotate runtime secrets, recreate the PostgreSQL volume, or delete data.

### Existing `scripts/dev-backend.sh` stacks

The repository’s wrapper remains useful for a deliberately managed development
stack and is also the legacy stack the GUI can offer to adopt:

```bash
scripts/dev-backend.sh up         # start PostgreSQL + Sacrum; no config/token write
scripts/dev-backend.sh provision  # seed the dev account and write config.toml
scripts/dev-backend.sh status
scripts/dev-backend.sh down       # stop containers; preserve the database volume
scripts/dev-backend.sh destroy    # stop containers and delete the database volume
```

The legacy stack uses the `vertebrae-dev_pgdata` named volume and PostgreSQL 17.
Adoption requires explicit GUI confirmation, preserves that volume and its legacy
database contract, and uses the already configured API token; it does not reseed
the account or silently migrate the volume to PostgreSQL 18. A missing or
unexpected volume, Docker context, image, port binding, or service causes the GUI
to refuse adoption rather than delete or recreate the data.

`down` preserves data across restarts. `destroy` and `docker compose ... down -v`
are destructive and should be used only when intentionally discarding the local
database. `vtb-daemon` does not own this lifecycle: it reads the shared Sacrum
connection settings and executes workflow steps, but it neither starts nor stops
Docker.

## Core Concepts

Work is organized as:

```text
epic
  ticket
    task
```

Tasks can have dependencies, structured sections, code references, assigned workflows, current workflow steps, execution history, and session logs. Workflow execution is coordinated by Sacrum and picked up by `vtb-daemon`, which runs the configured step prompt through Claude Code and streams output back to Sacrum.

## Configuration

Vertebrae reads Sacrum configuration from `~/.config/vertebrae/config.toml`. The CLI can also use `VTB_URL`, `VTB_TOKEN`, and `VTB_PROJECT_ID` environment overrides.

See [docs/SACRUM_CONFIG.md](docs/SACRUM_CONFIG.md) for the current format.

## License

Apache-2.0. See [LICENSE](LICENSE) for the Apache License 2.0 text.

Copyright 2026 Rafael Simon Garcia Rodriguez.
