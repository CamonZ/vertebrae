# Sacrum Configuration

This document describes the configuration format for the Sacrum backend used by Vertebrae clients.

## Configuration File

The Sacrum client reads configuration from `~/.config/vertebrae/config.toml`.

### Format

```toml
[sacrum]
url = "https://vertebrae.dev"
token = "your-token"

[projects.vertebrae]
id = "my-project-id"
path = "/Users/example/Code/vertebrae"
```

### Fields

`[sacrum]`

- **url** (optional): The base URL for the Sacrum API server
  - Default: `https://vertebrae.dev`
  - Example: `http://localhost:4000`

- **token** (required unless using `VTB_TOKEN`): Bearer token for GraphQL requests and Phoenix channel authentication

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
# Development configuration
[sacrum]
url = "http://localhost:4000"
token = "dev-token"

[projects.vertebrae]
id = "dev-project"
path = "/Users/example/Code/vertebrae"
```

```toml
# Production configuration
[sacrum]
url = "https://vertebrae.dev"
token = "prod-token"

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

## Task and Workflow ID Handling

The Sacrum API supports task lookup by both:
- **UUID**: Full unique identifier (e.g., `12345678-1234-5678-1234-567812345678`)
- **short_id**: Human-readable short ID (e.g., `task-123`)

The client passes IDs as-is to the API, allowing Sacrum to handle the lookup.
