# Config

Purpose: where Vertebrae configuration lives.
Use this when: keys, endpoints or project registration need to change.

## How it works
- The CLI, GUI and daemon share one `config.toml` in the platform config
  directory: macOS `~/Library/Application Support/vertebrae/config.toml`,
  Linux `~/.config/vertebrae/config.toml`. Sections include `[sacrum]`
  (backend URL and token), provider settings such as `[typesafe]`
  (structured_inference API key), `[providers.<id>]` (custom providers),
  `[daemon]` (daemon-wide settings), and `[projects.<name>]` (registered checkouts).
- `[daemon]` contains daemon-local settings. Rhai execute concurrency is
  controlled by the backend dispatcher; the daemon does not configure a local
  active or pending slot ceiling.
- `[providers.<id>]` declares a custom provider (e.g. OpenRouter, a local
  OpenAI-compatible server) for steps and local chat: `harness`
  (`claude`/`codex`/`typesafe`, required), `models` (the exact list, required),
  optional `default_model`, `base_url` (claude/codex) or `url` (typesafe),
  `api_key_env` (preferred) or `api_key`, an `env` table, and `wire_api`
  (codex: `chat`/`responses`). IDs are lowercase; `anthropic`, `openai`,
  `typesafe` and their aliases are reserved.
- Environment variables can override file values for the daemon (e.g. `TYPESAFE_API_KEY`).
- With the built-in providers, the `claude` and `codex` harness CLIs
  authenticate through their own CLIs; Vertebrae does not store their
  credentials. Custom providers take theirs from `api_key_env` (read from the
  daemon's/GUI's environment) or `api_key`.
- The daemon and GUI read config at startup: changes need a restart ([daemon](daemon.md)).

## Needs approval
Editing config and restarting the daemon.

## Never
Print secret values. To check a key is present, test for the key name only.

## Related
[Daemon](daemon.md) · [Permissions](../permissions.md)
