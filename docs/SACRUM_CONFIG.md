# Sacrum Configuration

This document describes the configuration format for the Sacrum HTTP backend.

## Configuration File

The Sacrum client reads configuration from `.vtb/config.toml`.

### Format

```toml
[sacrum]
url = "http://localhost:4000"
project_id = "my-project-id"
```

### Fields

- **url** (optional): The base URL for the Sacrum API server
  - Default: `http://localhost:4000`
  - Example: `http://api.example.com`

- **project_id** (required): The project ID in Sacrum
  - This is included in API requests as a query parameter or path segment
  - Example: `proj-123abc`

## Environment Variables

- **SACRUM_API_TOKEN** (required): The API authentication token
  - Must be set in your environment before running Vertebrae
  - Used for Bearer token authentication on all API requests
  - Example: `export SACRUM_API_TOKEN=your-secret-token`

## Example Configuration

```toml
# Development configuration
[sacrum]
url = "http://localhost:4000"
project_id = "dev-project"
```

```toml
# Production configuration
[sacrum]
url = "https://api.sacrum.example.com"
project_id = "prod-project"
```

## Configuration Resolution

The client resolves configuration in this order:

1. **API Token**: From `SACRUM_API_TOKEN` environment variable (required)
2. **Base URL**: From `[sacrum].url` in `.vtb/config.toml`, or defaults to `http://localhost:4000`
3. **Project ID**: From `[sacrum].project_id` in `.vtb/config.toml` (required)

If required fields are missing, an error will be returned.

## Task and Workflow ID Handling

The Sacrum API supports task lookup by both:
- **UUID**: Full unique identifier (e.g., `12345678-1234-5678-1234-567812345678`)
- **short_id**: Human-readable short ID (e.g., `task-123`)

The client passes IDs as-is to the API, allowing Sacrum to handle the lookup.
