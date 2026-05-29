# GUI Development

The GUI is a Tauri 2 + React 19 desktop application located in `crates/gui/`.

## Quick Start

```bash
cd crates/gui

# Install dependencies (first time only)
npm install

# Start development mode (hot reload enabled)
npm run tauri:dev
```

## Available Scripts

```bash
# Development
npm run dev              # Start Vite dev server only (port 1420)
npm run tauri:dev        # Start Tauri + Vite with hot reload

# Building
npm run build            # Build frontend (TypeScript + Vite)
npm run tauri:build      # Build production Tauri app

# Testing
npm run test             # Run tests once
npm run test:watch       # Run tests in watch mode
npm run test:coverage    # Run tests with coverage report

# Code Quality
npm run lint             # Run ESLint
npm run format           # Format with Prettier

# Utilities
npm run tauri            # Run any Tauri CLI command
npm run generate:types   # Generate TypeScript types from Rust
```

## Development Workflow

1. Run `npm run tauri:dev` to start the development environment
2. Edit React components in `src/` — changes hot reload automatically
3. Edit Rust backend in `src-tauri/src/` — Tauri rebuilds automatically
4. Run `npm run generate:types` after changing Rust command signatures

## Frontend Stack

| Technology | Version | Purpose |
|-----------|---------|---------|
| React | v19 | UI library |
| React Router | v7 | Routing |
| Zustand | v5 | State management |
| Tailwind CSS | v4 | Styling (custom neural-pathways theme) |
| XYFlow React | v12 | Graph visualization |
| Vite | v6 | Build tooling |
| Vitest | v4 | Test runner |
| Specta | v2 | Type-safe Rust-to-TypeScript bindings |

## Tauri Backend

The Rust backend in `src-tauri/src/` provides:

- **~34 Tauri commands** (`commands.rs`) — each acquires `RwLock<Option<VertebraeServices>>`, calls service method, converts to GUI type
- **WebSocket client** (`websocket_client.rs`) — Phoenix channel for real-time sync
- **Claude session manager** (`claude_session.rs`) — JSONL chat/session streaming
- **Project config** (`project_config.rs`) — multi-project management

## First-Run Installer

On first launch the GUI offers to install Vertebrae's command-line tools so
users can drive workflows from the terminal and run them in the background.
The flow is driven by Tauri commands in `src-tauri/src/install.rs`, which are
thin adapters over the shared [`vertebrae-installer`](../crates/installer)
crate. The CLI's `vtb daemon install/uninstall/status` are wrappers over the
same crate, so GUI- and CLI-driven installs land in identical locations.

### Welcome / consent screen

`src/pages/WelcomeInstallPage.tsx` renders the consent screen at `/welcome`.
It:

- Calls `installation_status` to pre-check the boxes and show each
  component's symlink target path.
- Offers two components — **vtb CLI** and **vtb-daemon** (background workflow
  runner) — each as an opt-out checkbox. A component already installed at our
  symlink path is shown as "already installed" and its checkbox is disabled;
  a component found elsewhere on `$PATH` is tagged "found on PATH".
- **Install** calls `install_components(install_cli, install_daemon)`, which
  stages the chosen sidecars and (if the daemon was selected) registers the
  daemon service. The user then proceeds to `/setup` (or `/` if a project was
  already selected).
- **Cancel** calls `quit_application`, which exits the app. Installation is
  required to continue — there is no "skip and install later".

### What gets installed

| Component | Purpose | Service registered? |
|-----------|---------|---------------------|
| `vtb` | CLI for managing tasks and workflows | No |
| `vtb-daemon` | Background workflow runner that executes agents | Yes — launchd (macOS) / systemd `--user` (Linux) |
| `vtb-gate` | Claude MCP permission prompt bridge for GUI chat sessions | No |

Each binary is copied into a per-OS data dir, set to `0o755`, and symlinked
into `~/.local/bin`. Installing the daemon additionally writes a service
definition and loads it so it starts at login. See
[Install Locations](#install-locations) below.

### Sidecar bundling

`vtb`, `vtb-daemon`, and `vtb-gate` ship inside the GUI bundle as Tauri `externalBin`
sidecars (declared in `src-tauri/tauri.conf.json`). They are produced and
staged at build time by `scripts/prepare-sidecars.mjs`, wired in via the
`beforeBuildCommand`:

```json
"beforeBuildCommand": "npm run tauri:prepare-sidecars && npm run build"
```

`prepare-sidecars.mjs` (run via `npm run tauri:prepare-sidecars`):

1. Detects the build target triple (honoring `TAURI_ENV_TARGET_TRIPLE`, else
   parsing `rustc -vV`). Supported triples: `aarch64-apple-darwin`,
   `x86_64-apple-darwin`, `x86_64-unknown-linux-gnu`.
2. Runs `cargo build --release -p vertebrae-cli -p vertebrae-daemon -p vtb-gate`.
3. Copies the release binaries to
   `src-tauri/binaries/<bin>-<target-triple>` — the naming Tauri's
   `externalBin` expects.

It is idempotent: if the staged copies already exist and are at least as new
as the source binaries in `target/release/`, the rebuild and copy are skipped,
keeping `tauri:dev` fast.

At bundle time `tauri-build` copies each staged sidecar next to the GUI
executable, stripping the `-<triple>` suffix. At runtime
`install_components` resolves them relative to the GUI executable using the
target triple baked in at build time, then hands them to
`vertebrae_installer::install_binary`.

### When the welcome screen is shown

`InstallationGuard` in `src/router.tsx` decides on mount. It calls
`installation_status` and redirects to `/welcome` **only when all** of the
following hold (first-run predicate):

```
!cli.installed_at_symlink &&
!daemon.installed_at_symlink &&
!cli.on_path &&
!daemon.on_path
```

In words: neither component is installed at the symlink path we manage and
neither is resolvable anywhere on `$PATH`. If the status probe fails, the
guard intentionally falls through to its children rather than blocking an
already-working install. `InstallationGuard` sits above `ProjectGuard`, so the
welcome screen comes before `/setup`.

### Install Locations

| Item | macOS | Linux |
|------|-------|-------|
| Data dir (shared root) | `~/Library/Application Support/Vertebrae` | `~/.local/share/vertebrae` |
| Staged binaries | `<data dir>/bin` | `<data dir>/bin` |
| GUI app state | `<data dir>/app-state.json` | `<data dir>/app-state.json` |
| User symlinks | `~/.local/bin` | `~/.local/bin` |
| Daemon service file | `~/Library/LaunchAgents/com.vertebrae.daemon.plist` | `~/.config/systemd/user/vertebrae-daemon.service` |
| Service manager / id | launchd label `com.vertebrae.daemon` | systemd `--user` unit `vertebrae-daemon` |
| Daemon logs | `~/Library/Logs/vertebrae/{daemon.log,daemon.error.log}` | `~/.local/state/vertebrae/logs/{daemon.log,daemon.error.log}` |

`app-state.json` holds GUI-local view state (currently the last opened
project). The project registry itself lives in the shared
`~/.config/vertebrae/config.toml`. All client data dirs are derived from
`vertebrae_installer::data_dir()`.

### Uninstalling

There is no GUI uninstall flow. Undo an install from the terminal:

1. **Remove the daemon service:**

   ```bash
   vtb daemon uninstall
   ```

   This unloads the service and removes the plist / systemd unit. It does
   **not** remove the staged binaries or the `~/.local/bin` symlinks.

2. **Remove the symlinks and staged binaries manually:**

   ```bash
   # symlinks
   rm -f ~/.local/bin/vtb ~/.local/bin/vtb-daemon

   # staged binaries (macOS)
   rm -rf "~/Library/Application Support/Vertebrae/bin"
   # staged binaries (Linux)
   rm -rf ~/.local/share/vertebrae/bin
   ```

   Removing the binaries and symlinks is enough to re-trigger the welcome
   screen on next launch, provided neither `vtb` nor `vtb-daemon` is otherwise
   resolvable on `$PATH`.

## Real-Time Sync

The GUI maintains a WebSocket connection to Sacrum via Phoenix channels:

- Connects to `ws://host:port/socket/websocket?token=api_token`
- Joins `project:{project_id}` channel
- 30-second heartbeat, exponential backoff reconnection (100ms -> 30s)
- Receives broadcasts for task/workflow/execution changes from all clients
- Emits Tauri events: `TaskChangedEvent`, `WorkflowChangedEvent`, `StepExecutionChangedEvent`

## Data Flow

```
CLI mutation -> Sacrum GraphQL API -> Sacrum broadcasts on WebSocket
            -> GUI WebSocket receives -> Tauri event -> React hooks -> Refetch & re-render

GUI mutation -> Tauri command -> VertebraeServices -> Sacrum GraphQL API
            -> Sacrum broadcasts on WebSocket -> React hooks -> Update state
```
