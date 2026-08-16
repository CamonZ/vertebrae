# Sacrum Configuration

This document describes the configuration format for the Sacrum backend used by Vertebrae clients.

## Configuration File

The Sacrum client reads configuration from `~/.config/vertebrae/config.toml`.

### Format

```toml
[sacrum]
mode = "remote"
url = "https://vertebrae.dev"
token = "your-token"

[projects.vertebrae]
id = "my-project-id"
path = "/Users/example/Code/vertebrae"
```

### Fields

`[sacrum]`

- **mode** (required by GUI backend setup): Who owns the Sacrum backend
  - `remote`: connect only; Vertebrae never invokes Docker for this backend
  - `local`: the GUI ensures a detached Docker Compose stack through the Docker daemon

- **url** (optional): The base URL for the Sacrum API server
  - Default: `https://vertebrae.dev`
  - Example: `http://localhost:4000`

- **token** (required unless using `VTB_TOKEN`): Bearer token for GraphQL requests and Phoenix channel authentication. Legacy stack adoption specifically requires this value to be persisted.

- **local** (required when `mode = "local"`): Local Docker identity and state; see [Local backend metadata](#local-backend-metadata)

`[projects.<slug>]`

- **id** (required unless using `VTB_PROJECT_ID`): The project ID in Sacrum
  - Example: `proj-123abc`

- **path** (required for CLI path matching): The git root path for the project
  - Example: `/Users/example/Code/vertebrae`

## Environment Variables

- **VTB_URL**: Overrides `[sacrum].url`
- **VTB_TOKEN**: Overrides `[sacrum].token`
- **VTB_PROJECT_ID**: Overrides path-based project resolution and uses the given Sacrum project ID directly

## Example Configuration

```toml
# Remote configuration
[sacrum]
mode = "remote"
url = "https://sacrum.example.com"
token = "sac_remote-token"

[projects.vertebrae]
id = "dev-project"
path = "/Users/example/Code/vertebrae"
```

```toml
# GUI-managed local configuration
[sacrum]
mode = "local"
url = "http://localhost:4400"
token = "sac_randomly-generated-api-token"

[sacrum.local]
compose_project = "vertebrae-local"
database_volume = "vertebrae-local_pgdata"
channel = "release"
image_ref = "ghcr.io/camonz/sacrum@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
provisioning_state = "ready"

[sacrum.local.runtime_secrets]
kind = "managed_file"
path = "/Users/example/Library/Application Support/vertebrae/local-backend.env"

[projects.vertebrae]
id = "local-project"
path = "/Users/example/Code/vertebrae"
```

## Local Backend Metadata

An explicit local configuration contains enough identity to find the same
detached Docker stack on every GUI launch:

- **compose_project**: Stable Docker Compose project name
- **database_volume**: Stable named volume containing PostgreSQL data
- **channel**: Typed image channel: `master` resolves through component metadata
  `backend-master`; `release` resolves through `backend-release`
- **image_ref**: Current Sacrum image reference from the official
  `ghcr.io/camonz/sacrum` repository, pinned by a canonical lowercase, full
  SHA-256 digest
- **provisioning_state**: `pending`, `in_progress`, `ready`, or `failed`; the
  startup decision carries this state so provisioning can start or retry safely
- **runtime_secrets**: Identity of the separate runtime-secret source

For GUI-created stacks, `runtime_secrets.kind` is `managed_file` and `path`
points to a file stored with owner-only permissions. The lifecycle code creates
and controls that file; this configuration only records its location. A
partially populated local section is loadable, but the startup policy reports
the precise missing fields and does not start Docker.

A complete managed local configuration also requires an absolute runtime-secret
path and an HTTP(S) URL whose host is `localhost` or a loopback IP address.
Remote URLs retain their existing semantics.

The supported legacy `scripts/dev-backend.sh` stack uses
`kind = "legacy_dev_compose"` after adoption because its existing development
secrets remain in that Compose definition.

## Secret Storage Boundary

`config.toml` contains the Sacrum API token because the CLI, GUI, and daemon
need it to authenticate. It must not contain the local account password,
`SECRET_KEY_BASE`, or PostgreSQL password. For a newly managed stack those
values are generated or collected during setup and stored in the separate
owner-only runtime-secret file. The plaintext account password is discarded
after successful provisioning.

## Configuration Resolution

The CLI resolves configuration in this order:

1. **Base URL**: `VTB_URL`, then `[sacrum].url`, then `https://vertebrae.dev`
2. **API token**: `VTB_TOKEN`, then `[sacrum].token`
3. **Project ID**: `VTB_PROJECT_ID`, otherwise the project whose configured `path` is the longest prefix of the current git root

If required fields are missing, an error will be returned.

Environment variables override client connection values only. They do not
change the persisted `mode` or transfer ownership of a remote backend to the
GUI. In particular, `VTB_URL=http://localhost:...` never implies local mode.
The startup caller resolves the effective URL/token first, then passes those
values separately to the ownership policy. A `VTB_TOKEN` can therefore satisfy
connection completeness for an explicit remote or local mode without writing
or changing `mode`. It cannot make a mode-less configuration eligible for
legacy adoption because the adopted configuration must remain usable after the
environment override is removed.

The token-only GUI settings command preserves `mode` and local metadata exactly.
Choosing local or remote is a separate explicit setup action; saving a token in
a mode-less configuration does not silently select remote mode.

Lifecycle strings written by newer clients are retained when an older CLI,
daemon, or GUI loads and saves the shared file. An unknown backend mode,
channel, provisioning state, or runtime-secret kind does not block ordinary
URL, token, and project resolution. The GUI startup policy reports the unknown
value as unsupported and requires setup instead of guessing its meaning.

The GUI resolves configuration by selected project slug using `SacrumConfig::load_for_project()`. It reads `[sacrum].url`, `[sacrum].token`, and `[projects.<slug>].id` from the global config file.

## GUI Startup Decisions

The GUI applies one deterministic policy before connecting:

- Explicit `remote` with a URL and token: connect without invoking Docker.
- Explicit `local` with complete connection and local metadata: ensure the
  detached stack through the Docker daemon.
- Missing mode with a separately verified `scripts/dev-backend.sh` Docker
  identity: offer adoption.
- Any other missing mode or incomplete configuration: require setup and report
  what is missing.

Legacy detection requires Docker inspection to find both the Compose project
`vertebrae-dev` and database volume `vertebrae-dev_pgdata`, plus the observed
backend endpoint and immutable image digest. The inspected image must be the
official `ghcr.io/camonz/sacrum` image with a canonical lowercase SHA-256
digest. The probe must successfully authenticate, and its opaque token
fingerprint is retained in the evidence object without exposing the plaintext
token through debug output.

The observed endpoint and authenticated token must match the complete URL and
token already persisted in `[sacrum]`; environment-only values are deliberately
insufficient. A localhost URL by itself is not evidence, and empty, stale, or
mismatched mode-less configurations are diagnosed rather than offered for
adoption. Adoption also requires explicit user confirmation. Once confirmed,
Vertebrae saves `mode = "local"`, channel `master`, the inspected digest-pinned
image, the exact Compose/volume identity, and `kind = "legacy_dev_compose"`
without changing the existing URL, API token, database volume, or development
credentials.

## Task and Workflow ID Handling

The Sacrum API supports task lookup by both:
- **UUID**: Full unique identifier (e.g., `12345678-1234-5678-1234-567812345678`)
- **short_id**: Human-readable short ID (e.g., `task-123`)

The client passes IDs as-is to the API, allowing Sacrum to handle the lookup.
