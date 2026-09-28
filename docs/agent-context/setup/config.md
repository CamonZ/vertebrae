# Config

Purpose: where Vertebrae configuration lives.
Use this when: keys, endpoints or project registration need to change.

## How it works
- The CLI, GUI and daemon share one `config.toml` in the platform config
  directory: macOS `~/Library/Application Support/vertebrae/config.toml`,
  Linux `~/.config/vertebrae/config.toml`. Sections include `[sacrum]`
  (backend URL and token), provider settings such as `[typesafe]`
  (structured_inference API key), and `[projects.<name>]` (registered checkouts).
- Environment variables can override file values for the daemon (e.g. `TYPESAFE_API_KEY`).
- The `claude` and `codex` harness CLIs authenticate through their own CLIs;
  Vertebrae does not store their credentials.
- The daemon reads config at startup: changes need a restart ([daemon](daemon.md)).

## Needs approval
Editing config and restarting the daemon.

## Never
Print secret values. To check a key is present, test for the key name only.

## Related
[Daemon](daemon.md) · [Permissions](../permissions.md)
