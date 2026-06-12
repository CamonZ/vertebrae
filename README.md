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

# Run local Rust tests, excluding Docker-backed acceptance crates
cargo test --quiet --workspace --exclude acceptance --exclude gui-acceptance --exclude daemon-acceptance

# Run the CLI
vtb --help

# Start GUI development
cd crates/gui
npm install
npm run tauri:dev
```

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

MIT
