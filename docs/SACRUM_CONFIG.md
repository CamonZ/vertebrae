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

[typesafe]
api_key = "<typesafe-api-key>"
url = "https://api.typesafe.ai/v1/systemone"

[projects.vertebrae]
id = "my-project-id"
path = "/Users/example/Code/vertebrae"

[providers.openrouter]
harness = "claude"
base_url = "https://openrouter.ai/api"
api_key_env = "OPENROUTER_API_KEY"
models = ["moonshotai/kimi-k2", "z-ai/glm-5"]
default_model = "moonshotai/kimi-k2"
```

### Fields

`[sacrum]`

- **url** (optional): The base URL for the Sacrum API server
  - Default: `https://vertebrae.dev`
  - A GUI-managed local backend uses its loopback URL and selected host port.

- **token** (required unless using `VTB_TOKEN`): Bearer token for GraphQL requests and Phoenix channel authentication. Do not print or commit it.

`[typesafe]`

- **api_key** (optional): Server-side API key for TypeSafe System One requests.
  The daemon reads it from the shared `config.toml` at startup. Protect this file
  as a credential store; Vertebrae writes it with owner-only permissions on
  Unix. The daemon redacts it from Debug output and diagnostics. Do not print or
  commit the key.

- **url** (optional): Full TypeSafe System One HTTP(S) endpoint URL. Requests
  POST to this URL exactly as configured; Vertebrae does not append a path.
  Default: `https://api.typesafe.ai/v1/systemone`. URLs with credentials,
  query strings, or fragments are rejected.

`[projects.<slug>]`

- **id** (required unless using `VTB_PROJECT_ID`): The project ID in Sacrum
  - Example: `proj-123abc`

- **path** (required for CLI path matching): The git root path for the project
  - Example: `/Users/example/Code/vertebrae`

`[providers.<id>]`

Custom providers for workflow steps and local chat on this machine. The
built-in providers (`anthropic`, `openai`, `typesafe`) need no entry. IDs use
lowercase letters, digits, `-`, and `_`; built-in names and their aliases
(`claude`, `codex`, `system-one`, …) are reserved.

- **harness** (required): `claude`, `codex`, or `typesafe` — the runtime that
  talks to this provider.
- **models** (required): The exact model IDs this provider serves. Steps and
  chats using the provider may only select these; built-in catalog prefix rules
  never apply.
- **default_model** (optional): Used when no model is selected; must be listed
  in `models`. Defaults to the first entry.
- **base_url** (`claude`/`codex`): API base URL. Claude receives it as
  `ANTHROPIC_BASE_URL`; Codex receives it as
  `model_providers.<id>.base_url`.
- **url** (`typesafe`): Full System One endpoint URL, with the same semantics
  as `[typesafe].url`.
- **api_key_env** (preferred) / **api_key**: The credential. A nonblank value
  of the named environment variable (read from the daemon's or GUI's process
  environment) wins over the literal `api_key`; a configured but missing
  `api_key_env` without an `api_key` fails the run. Claude receives it as
  `ANTHROPIC_AUTH_TOKEN` (with `ANTHROPIC_API_KEY` cleared); Codex reads it
  through a generated `env_key`; TypeSafe sends it as its bearer key instead of
  the `[typesafe]` section. Debug output and diagnostics redact it.
- **env** (`claude`/`codex`, optional table): Extra environment for the
  harness process. Values are redacted from Debug output.
- **wire_api** (`codex`, optional): `chat` or `responses`.

Codex custom providers are defined entirely here; Vertebrae passes them as
`-c model_providers.<id>.*` overrides, so `~/.codex/config.toml` needs no
edits. `claude`/`codex` providers appear in the local chat provider picker;
`typesafe` providers are step-only. A step whose provider is not configured on
the executing daemon, or whose explicit harness disagrees with the provider's,
fails with a descriptive error. Like `[typesafe]`, provider profiles are
snapshotted at daemon and GUI startup.

## Environment Variables

- **VTB_URL**: Overrides `[sacrum].url`
- **VTB_TOKEN**: Overrides `[sacrum].token`
- **VTB_PROJECT_ID**: Overrides path-based project resolution and uses the given Sacrum project ID directly
- **TYPESAFE_API_KEY**: A nonblank value overrides `[typesafe].api_key` for the daemon. If unset or blank, the daemon uses the TOML value. If neither source has a usable key, TypeSafe requests report that configuration is missing.
- **TYPESAFE_BASE_URL**: Overrides `[typesafe].url` and preserves the legacy
  base URL behavior: Vertebrae appends `/v1/systemone` to this value. If it is
  unset, the daemon uses `[typesafe].url`, then the default endpoint above.

The daemon snapshots the resolved TypeSafe settings at startup; changes to the
TOML file or environment take effect after restarting it. The credential stays in
daemon configuration and is not copied into task or workflow data, `AgentConfig`,
or provider-neutral request configuration.

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
re-enrollment error. A machine-readable `not_found`, `deregistered`, or equivalent
terminal response means the standalone identity was retired while offline: the
daemon atomically removes `reconnect_token` from `daemon.toml`, writes a retired
marker, preserves `daemon.lock`, and stops without entering another retry loop.
Transient and ambiguous responses do not clear credentials and remain retryable.
On restart, a retired marker fails before startup, so the daemon cannot silently
fall back to `[sacrum].token`. Re-enrollment with
`--replace-existing` clears the marker and writes a fresh reconnect credential.
Unexpected supervisor termination exits the executable with a failure status so the
existing service manager can restart it. Initial connection failures also exit
unsuccessfully. Restart always reuses the saved identity; it does not repeat the
bootstrap exchange. Reconnect credentials are not automatically refreshed; expiry
or revocation requires explicit re-enrollment.
The daemon uses the enrolled identity for both daemon-channel command delivery
and project-scoped GraphQL reporting. It does not join project channels or use
`[sacrum].token` for execution. Existing account-token daemon installations
must be enrolled before they can continue executing work.

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
