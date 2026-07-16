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
│   ├── harness-core/        # Provider-neutral harness runtime/event contracts
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
# Build the default Rust workspace members (excludes the GUI and acceptance crates)
cargo build --quiet

# Build the default Rust workspace members in release mode
cargo build --release --quiet

# Build/package everything in dependency order:
# vtb, vtb-daemon, vtb-gate, staged Tauri sidecars, then the GUI bundle
scripts/build-package.sh --release

# Build/package debug artifacts instead
scripts/build-package.sh --debug

# Run the CLI from the build output
target/debug/vtb <args>
```

The root `Cargo.toml` uses `default-members` so bare `cargo build` does not
compile the Tauri GUI crate. This keeps a clean checkout buildable without
pre-staged sidecars. Commands that explicitly use `--workspace` still compile
the GUI crate, but the GUI build script disables Tauri `externalBin` copying for
non-bundling Cargo builds so Rust tests and linting do not depend on
`crates/gui/src-tauri/binaries/`.

Use `scripts/build-package.sh` when you need a runnable desktop bundle. It
delegates sidecar build and staging to
`crates/gui/scripts/prepare-sidecars.mjs`, which is the single source of truth
for target-triple detection and `src-tauri/binaries/<bin>-<triple>` staging.
Set `SIDECAR_PROFILE=debug` or pass `--debug` to build debug sidecars and a
debug GUI bundle; release is the default. On macOS the wrapper defaults to
`--bundles app` to produce a repeatable runnable `.app` bundle without requiring
DMG packaging; set `TAURI_BUNDLES` or pass `--bundles` to request other Tauri
bundle formats. DMG builds use Tauri's normal create-dmg flow first, then retry
without Finder window customization if that AppleScript step fails.

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
