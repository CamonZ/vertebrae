# Sacrum Configuration

This document describes the configuration format for the Sacrum backend used by Vertebrae clients.

## Configuration File

The Sacrum client reads `config.toml` from Vertebrae’s platform configuration
directory (for example, `~/.config/vertebrae/config.toml` on Linux and
`~/Library/Application Support/vertebrae/config.toml` on macOS).

### Format

```toml
[sacrum]
url = "<backend-url>"
token = "<api-token>"

[projects.vertebrae]
id = "my-project-id"
path = "/Users/example/Code/vertebrae"
```

### Fields

`[sacrum]`

- **url** (optional): The base URL for the Sacrum API server
  - Default: `https://vertebrae.dev`
  - A GUI-managed local backend uses its loopback URL and selected host port.

- **token** (required unless using `VTB_TOKEN`): Bearer token for GraphQL requests and Phoenix channel authentication. Do not print or commit it.

`[projects.<slug>]`

- **id** (required unless using `VTB_PROJECT_ID`): The project ID in Sacrum
  - Example: `proj-123abc`

- **path** (required for CLI path matching): The git root path for the project
  - Example: `/Users/example/Code/vertebrae`

## Environment Variables

- **VTB_URL**: Overrides `[sacrum].url`
- **VTB_TOKEN**: Overrides `[sacrum].token`
- **VTB_PROJECT_ID**: Overrides path-based project resolution and uses the given Sacrum project ID directly

## Backend ownership

Remote and local backends use exactly the same `[sacrum].url` and
`[sacrum].token` fields. The CLI, GUI, `sacrum-client`, and `vtb-daemon` remain
transparent consumers of those fields.

When the GUI manages a local Docker backend, its private application-data directory
also contains `local-backend/compose.yaml`, `runtime.env`, `api-token`, and
`state.json`. Those files control the Docker target, pinned image, named volume,
loopback port, and startup reconciliation. They are not part of `config.toml`, and
the runtime secrets must never be copied into it.

The GUI creates a fresh stack with PostgreSQL 18, logical replication, migrations,
health checks, generated runtime secrets, and a generated one-shot seed account.
Ready-state startup reuses the existing token and volume. An explicitly confirmed
legacy adoption keeps the `vertebrae-dev_pgdata` PostgreSQL 17 volume and existing
account/token instead of reseeding or upgrading that volume. `vtb-daemon` does not
manage either Docker lifecycle; it only uses the shared connection settings.

## Example Configuration

```toml
# Development configuration
[sacrum]
url = "http://127.0.0.1:<port>"
token = "<local-api-token>"

[projects.vertebrae]
id = "dev-project"
path = "/Users/example/Code/vertebrae"
```

```toml
# Production configuration
[sacrum]
url = "https://vertebrae.dev"
token = "<remote-api-token>"

[projects.vertebrae]
id = "prod-project"
path = "/srv/vertebrae"
```

## Configuration Resolution

The CLI resolves configuration in this order:

1. **Base URL**: `VTB_URL`, then `[sacrum].url`, then `https://vertebrae.dev`
2. **API token**: `VTB_TOKEN`, then `[sacrum].token`
3. **Project ID**: `VTB_PROJECT_ID`, otherwise the project whose configured `path` is the longest prefix of the current git root

If required fields are missing, an error will be returned.

The GUI resolves configuration by selected project slug using `SacrumConfig::load_for_project()`. It reads `[sacrum].url`, `[sacrum].token`, and `[projects.<slug>].id` from the global config file.

Changing backend management in the GUI updates only the connection URL/token and
the GUI’s private local-backend state. It does not add Docker settings to the
shared file. If Docker is unavailable, the local port is occupied, the saved
volume is missing, or the legacy stack is unsafe to adopt, the GUI reports a
diagnostic and leaves existing data in place for recovery.

## Task and Workflow ID Handling

The Sacrum API supports task lookup by both:
- **UUID**: Full unique identifier (e.g., `12345678-1234-5678-1234-567812345678`)
- **short_id**: Human-readable short ID (e.g., `task-123`)

The client passes IDs as-is to the API, allowing Sacrum to handle the lookup.
