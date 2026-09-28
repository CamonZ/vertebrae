# Daemon

Purpose: the local process that executes AI steps.
Use this when: steps are not executing, or after changing credentials or config.

## How it works
- The daemon connects to the backend, receives dispatched `llm_inference` and
  `structured_inference` steps, runs them through the harnesses, and reports results.
- Installed by the GUI onboarding. On macOS it runs under launchd as
  `com.vertebrae.daemon`; binary in `~/Library/Application Support/Vertebrae/bin/`.
- It reads config and credentials at startup.

## Doing it (needs consent)
Restart on macOS: `launchctl kickstart -k gui/$(id -u)/com.vertebrae.daemon`.
Check activity: `tail -n 100 ~/Library/Logs/vertebrae/daemon.log`.

## When to restart
After changing `config.toml` or provider keys, after updating the daemon
binary, or when a provider keeps failing auth with a key you know is valid.

## Gotchas
A restart does not resume a failed run; start a new TaskRun after it
([retries and recovery](../running/retries-and-recovery.md)).

## Related
[Config](config.md) · [Logs and outcomes](../debugging/logs-and-outcomes.md)
