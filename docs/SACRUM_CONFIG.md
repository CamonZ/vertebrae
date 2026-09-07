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

Remote and local account-authenticated clients use exactly the same
`[sacrum].url` and `[sacrum].token` fields. The CLI, GUI, and `sacrum-client`
remain transparent consumers of those fields. An enrolled standalone daemon
uses its protected `daemon.toml` endpoint and reconnect credential instead.

## Standalone daemon enrollment

The GUI issues a one-time bootstrap credential for a daemon identity. On the
machine that will run the daemon, exchange it without installing an account
API token:

```bash
vtb-daemon enroll --endpoint 'https://sacrum.example.com' \
  --daemon-id '<daemon-uuid>' --token-stdin < /path/to/protected-bootstrap-token
```

The input must be a pipe or redirected file; terminal input is rejected to avoid
echoing the secret. Protect any input file with owner-only permissions.

The command calls `/api/daemon/exchange`, then stores the server-issued stable
ID and reconnect credential in the protected sibling file
`daemon.toml` (0600 on Unix), beside the shared configuration. On macOS this
is `~/Library/Application Support/vertebrae/daemon.toml`; on Linux it is normally
`~/.config/vertebrae/daemon.toml`. The credential is never
printed. Re-enrollment for the same identity requires `--replace-existing`;
an attempt to replace a different configured identity is rejected. A corrupt
or partial file is reported without its contents and is never replaced automatically.
Enrollment holds a process lock across the exchange and local write, so a competing
enrollment fails before consuming its bootstrap credential. The persistent
`daemon.lock` file is not a credential and must not be deleted to release the lock;
the operating system releases the lock when the enrollment process exits.

On restart, `vtb-daemon` authenticates the Phoenix socket with the stored
`daemon_id` and `reconnect_token`, then joins `daemon:<daemon_id>`. Network
disconnects and channel interruptions retry indefinitely with capped exponential
backoff and jitter. Each WebSocket connection attempt has a 15-second timeout.
A duplicate registration retries because a previous connection can take time to
disappear from the backend. Explicitly rejected credentials stop with an actionable
re-enrollment error. Unexpected supervisor termination exits the executable with
a failure status so the existing service manager can restart it. Initial connection
failures also exit unsuccessfully. Restart always reuses the saved identity; it does
not repeat the bootstrap exchange. Reconnect credentials are not automatically
refreshed; expiry or revocation requires explicit re-enrollment.
The current Sacrum backend grants this standalone channel registration only; it
does not yet authorize project execution/reporting for a daemon principal. The
existing account-token daemon path remains unchanged for project execution,
and the daemon does not silently fall back to it when standalone identity mode
is configured.

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
