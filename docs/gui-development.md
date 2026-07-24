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
npm run package          # Build sidecars, stage them, then build the GUI bundle
npm run package:debug    # Same flow with debug sidecars and a debug GUI bundle

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
crate. The GUI is the supported owner of daemon installation, so all installer
UI and lifecycle changes should be made through this flow.

### Welcome / consent screen

`src/pages/WelcomeInstallPage.tsx` renders the consent screen at `/welcome`.
It:

- Calls `installation_status` to pre-check the boxes and show each
  component's symlink target path.
- Offers three components — **vtb CLI**, **vtb-daemon** (background workflow
  runner), and **vtb-gate** (Claude permission bridge) — each as an opt-out
  checkbox. A component already installed at our symlink path and current with
  the bundled sidecar is shown as "already installed" and its checkbox is
  disabled; a managed component whose staged binary differs from the bundled
  sidecar stays checked and is tagged "update available"; a component found
  elsewhere on `$PATH` is tagged "found on PATH".
- **Install** calls
  `install_components(install_cli, install_daemon, install_gate)`, which stages
  the chosen sidecars and (if the daemon was selected) registers the daemon
  service. The user then proceeds to `/setup` (or `/` if a project was already
  selected).
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

`vtb`, `vtb-daemon`, and `vtb-gate` ship inside the GUI bundle as Tauri
`externalBin` sidecars (declared in `src-tauri/tauri.conf.json`). The supported
packaging entry point is the root wrapper:

```bash
scripts/build-package.sh --release
scripts/build-package.sh --debug
```

From `crates/gui`, the equivalent npm affordances are:

```bash
npm run package
npm run package:debug
```

The wrapper builds and stages the sidecars first, then invokes the Tauri bundle
build. On macOS it defaults to `--bundles app` so the repeatable path produces a
runnable `.app` without requiring DMG tooling; set `TAURI_BUNDLES` or pass
`--bundles` to request another Tauri bundle format. For `--bundles dmg`, the
wrapper first uses Tauri's normal DMG path; if create-dmg fails during Finder
window customization, it retries with Finder customization skipped. Sidecar
staging itself is centralized in `scripts/prepare-sidecars.mjs`,
which remains wired into Tauri's `beforeDevCommand` and `beforeBuildCommand` so
direct `npm run tauri:dev` and `npm run tauri:build` commands continue to work:

```json
"beforeBuildCommand": "npm run tauri:prepare-sidecars && npm run build"
```

`prepare-sidecars.mjs` (run via `npm run tauri:prepare-sidecars`):

1. Detects the build target triple (honoring `TAURI_ENV_TARGET_TRIPLE`, else
   parsing `rustc -vV`). Supported triples: `aarch64-apple-darwin`,
   `x86_64-apple-darwin`, `aarch64-unknown-linux-gnu`,
   `x86_64-unknown-linux-gnu`.
2. Removes staged sidecars for the other supported target triples so stale
   non-host binaries cannot be bundled accidentally.
3. Runs `cargo build --release -p vertebrae-cli -p vertebrae-daemon -p vtb-gate`
   by default, or a debug build when `SIDECAR_PROFILE=debug`, `--debug`, or
   `--profile debug` is used.
4. Copies the profile's binaries to
   `src-tauri/binaries/<bin>-<target-triple>` — the naming Tauri's
   `externalBin` expects.

It is idempotent per profile: if the staged profile marker matches the
requested profile and the staged copies are at least as new as the source
binaries in `target/<profile>/`, the rebuild and copy are skipped. Switching
between debug and release forces a restage so bundles do not accidentally reuse
sidecars from the other profile.

At bundle time `tauri-build` copies each staged sidecar next to the GUI
executable, stripping the `-<triple>` suffix. At runtime
`install_components` resolves them relative to the GUI executable using the
target triple baked in at build time, then hands them to
`vertebrae_installer::install_binary`.

Bare Rust builds and tests are intentionally separate from GUI bundling.
`cargo build` uses the workspace's default members, which exclude the Tauri GUI
crate. `cargo test --workspace --exclude acceptance --exclude gui-acceptance
--exclude daemon-acceptance` still compiles the GUI crate, but `build.rs`
removes `externalBin` from Tauri's build configuration unless
`VERTEBRAE_BUNDLE_SIDECARS=1` is set by the npm/Tauri packaging scripts.

### When the welcome screen is shown

`InstallationGuard` in `src/router.tsx` decides on mount. It calls
`installation_status` and redirects to `/welcome` when any required component
is missing:

```
!component.installed_at_symlink && !component.on_path
```

In words: a component is missing only when it is neither installed at the
symlink path we manage nor resolvable anywhere on `$PATH`. If the status probe
fails, the guard intentionally falls through to its children rather than
blocking an already-working install. `InstallationGuard` sits above
`ProjectGuard`, so the welcome screen comes before `/setup`.

### Silent refresh of managed installs

Stale GUI-managed binaries never route through the welcome screen. At startup
(release builds only), `refresh_stale_managed_binaries` in
`src-tauri/src/install.rs` compares each managed staged binary against the
bundled sidecar and silently rewrites it when the bytes differ, keeping the
managed symlink pointed at the staged path. If the daemon binary was
refreshed and its service is registered, the service is reloaded so the
running daemon picks up the new bytes.

Only installer-managed artifacts are touched: PATH-only installs and
unrelated files at the symlink path are never rewritten, and missing
components remain a welcome-screen consent decision. Failures are logged and
never block startup. Debug builds skip the refresh entirely — in dev the
"sidecars" next to the executable are just sibling `target/debug` binaries.

### Install Locations

| Item | macOS | Linux |
|------|-------|-------|
| Data dir (shared root) | `~/Library/Application Support/Vertebrae` | `~/.local/share/vertebrae` |
| Staged binaries | `<data dir>/bin` | `<data dir>/bin` |
| Installed skills root | `~/Library/Application Support/Vertebrae/skills` | `~/.local/share/vertebrae/skills` |
| GUI app state | `<data dir>/app-state.json` | `<data dir>/app-state.json` |
| User symlinks | `~/.local/bin` | `~/.local/bin` |
| Daemon service file | `~/Library/LaunchAgents/com.vertebrae.daemon.plist` | `~/.config/systemd/user/vertebrae-daemon.service` |
| Service manager / id | launchd label `com.vertebrae.daemon` | systemd `--user` unit `vertebrae-daemon` |
| Daemon logs | `~/Library/Logs/vertebrae/{daemon.log,daemon.error.log}` | `~/.local/state/vertebrae/logs/{daemon.log,daemon.error.log}` |

`app-state.json` holds GUI-local view state (currently the last opened
project). The project registry itself lives in the shared
`~/.config/vertebrae/config.toml`. All client data dirs are derived from
`vertebrae_installer::data_dir()`.

Vertebrae-installed skills use the provider-neutral
`vertebrae_installer::installed_skills_dir()` contract. Each bundle is stored
as `<installed skills root>/<name>/SKILL.md`. The installer owns idempotent
creation of the root through `provision_installed_skills_dir()` and preserves
existing contents; the skills-assets layer owns files below it. The GUI stages
this bundle in its application setup hook before provider capability discovery,
independently of project registration. Provider integrations append this
absolute root to their normal discovery and must not create `.claude`,
`.agents`, or `.codex` directories or change the active project to expose it.
On Linux this is application data under `.local/share`, not configuration under
`.config`.

The Tauri setup hook resolves Claude's executable, PATH, and installed-skill
compatibility once and shares that immutable result with local-chat sessions.
Installing or updating Claude Code or managed skills while the GUI remains
open takes effect after restarting the application; the cached warning and
fallback guidance are still delivered to each affected session.

### Uninstalling

There is no GUI uninstall flow. Undo an install from the terminal:

1. **Remove the daemon service manually:**

   ```bash
   launchctl bootout gui/$UID ~/Library/LaunchAgents/com.vertebrae.daemon.plist
   rm -f ~/Library/LaunchAgents/com.vertebrae.daemon.plist
   ```

   On Linux, use `systemctl --user disable --now vertebrae-daemon` and remove
   `~/.config/systemd/user/vertebrae-daemon.service`. This does **not** remove
   the staged binaries or the `~/.local/bin` symlinks.

2. **Remove the symlinks and staged binaries manually:**

   ```bash
   # symlinks
   rm -f ~/.local/bin/vtb ~/.local/bin/vtb-daemon ~/.local/bin/vtb-gate

   # staged binaries (macOS)
   rm -rf "~/Library/Application Support/Vertebrae/bin"
   # staged binaries (Linux)
   rm -rf ~/.local/share/vertebrae/bin
   ```

   Removing the binaries and symlinks is enough to re-trigger the welcome
   screen on next launch, provided none of `vtb`, `vtb-daemon`, or `vtb-gate`
   is otherwise resolvable on `$PATH`.

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
