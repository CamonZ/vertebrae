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
- **PTY manager** (`pty_manager.rs`) — embedded terminal sessions
- **Workflow runner** (`workflow_runner/`) — automated step execution engine
- **Project config** (`project_config.rs`) — multi-project management

## Real-Time Sync

The GUI maintains a WebSocket connection to Sacrum via Phoenix channels:

- Connects to `ws://host:port/socket/websocket?token=api_token`
- Joins `project:{project_id}` channel
- 30-second heartbeat, exponential backoff reconnection (100ms -> 30s)
- Receives broadcasts for task/workflow/execution changes from all clients
- Emits Tauri events: `TaskChangedEvent`, `WorkflowChangedEvent`, `StepExecutionChangedEvent`

## Data Flow

```
CLI mutation -> Sacrum REST API -> Sacrum broadcasts on WebSocket
            -> GUI WebSocket receives -> Tauri event -> React hooks -> Refetch & re-render

GUI mutation -> Tauri command -> VertebraeServices -> Sacrum REST API
            -> Sacrum broadcasts on WebSocket -> React hooks -> Update state
```
