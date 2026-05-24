# Project Overview

Vertebrae is a persistent task management and AI workflow orchestration platform written in Rust. It provides CLI (`vtb`), desktop GUI (Tauri + React), and background daemon interfaces that communicate with the Sacrum backend (Elixir/Phoenix) via GraphQL and Phoenix channels.

> For the full system architecture including Sacrum, see [System Overview](system-overview.md).

## Project Structure

```
vertebrae/
├── Cargo.toml              # Workspace manifest
├── Cargo.lock              # Locked dependency versions
├── AGENTS.md               # Agent instructions (index-based)
├── CLAUDE.md               # Claude Code instructions (index-based)
├── .claude/
│   └── settings.json       # Claude Code hooks configuration
├── .githooks/
│   └── pre-commit          # Git pre-commit hook script
├── scripts/
│   └── setup.sh            # Initial dev environment setup
├── skills/                 # Claude Code skills (each is a folder with SKILL.md)
├── crates/
│   ├── core/               # vertebrae-core: Shared contract layer (traits + models)
│   ├── sacrum-client/      # vertebrae-sacrum-client: GraphQL client for Sacrum
│   ├── cli/                # vertebrae-cli: CLI binary (vtb)
│   ├── daemon/             # vertebrae-daemon: Background step executor (vtb-daemon)
│   ├── installer/          # vertebrae-installer: Stages binaries + registers the daemon service
│   ├── gui/                # Tauri + React desktop application
│   ├── acceptance/         # Acceptance tests (Docker only)
│   ├── gui-acceptance/     # GUI acceptance tests (Docker only)
│   └── daemon-acceptance/  # Daemon acceptance tests (Docker only)
├── docs/                   # Documentation
│   ├── design/             # GUI design docs and mockups
│   └── tickets/            # Feature tickets and specs
└── target/                 # Build artifacts (git-ignored)
```

## Build Commands

```bash
# Build the project (quiet mode reduces output)
cargo build --quiet

# Build in release mode
cargo build --release --quiet

# Run the CLI tool
vtb <args>
```

## Dependencies

### Core Runtime

| Crate | Version | Purpose |
|-------|---------|---------|
| `reqwest` | v0.13 | HTTP client used for Sacrum GraphQL |
| `tokio` | v1 | Async runtime |
| `tokio-tungstenite` | v0.26 | WebSocket client for Phoenix channels |
| `clap` | v4 | CLI argument parsing with derive macros |
| `serde` / `serde_json` | v1 | Serialization/deserialization |
| `chrono` | v0.4 | Date/time handling |
| `thiserror` | v2 | Error type derivation |
| `async-trait` | v0.1 | Async trait support |
| `tracing` | v0.1 | Structured logging |
| `ractor` | — | Actor framework (daemon) |

### GUI

| Crate/Package | Version | Purpose |
|---------------|---------|---------|
| `tauri` | v2.9 | Desktop application framework |
| `specta` / `tauri-specta` | v2 | Type-safe Rust-to-TypeScript bindings |
| React | v19 | Frontend UI library |
| Zustand | v5 | State management |
| Vite | v6 | Build tooling |
| Tailwind CSS | v4 | Styling |
| Vitest | v4 | Test runner |
| @testing-library/react | v16 | Component testing utilities |
| XYFlow React | v12 | Graph visualization |

### Development Tools

Install separately:

```bash
cargo install cargo-llvm-cov    # Code coverage
```
