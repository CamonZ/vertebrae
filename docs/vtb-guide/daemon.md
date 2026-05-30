# Daemon Management

The daemon (`vtb-daemon`) is a background service that executes workflow steps by spawning a local harness CLI — Claude Code (`claude`) for `anthropic` provider steps and Codex CLI (`codex`) for `openai` provider steps. See [Provider Selection](steps.md#provider-selection-anthropic--openai) for how to pick a harness per step. It runs as a macOS launchd service or a Linux systemd `--user` service.

```bash
# Install as a launchd or systemd user service
vtb daemon install

# Install with explicit binary path
vtb daemon install --binary /usr/local/bin/vtb-daemon

# Check daemon status
vtb daemon status

# Uninstall the service
vtb daemon uninstall
```

### Daemon Install Options

```bash
vtb daemon install [OPTIONS]
```

| Flag | Description |
|------|-------------|
| `--binary <BINARY>` | Explicit path to the `vtb-daemon` binary; if omitted, the CLI resolves `vtb-daemon` from `PATH` with `which` |
| `--json` | Appears in generated help but is currently ignored for daemon commands; output remains human-readable |
| `-h, --help` | Print command help |

`vtb daemon install` has no aliases, positional arguments, short flags,
defaults, or value enums. If `--binary` is provided, the path must exist and is
canonicalized before installation. Without `--binary`, `vtb-daemon` must be on
`PATH`; otherwise the command fails with a hint to install it or pass
`--binary`. On macOS, installation writes
`~/Library/LaunchAgents/com.vertebrae.daemon.plist`, loads it with
`launchctl`, and logs to `~/Library/Logs/vertebrae/{daemon.log,daemon.error.log}`.
On Linux, installation writes
`~/.config/systemd/user/vertebrae-daemon.service`, runs `systemctl --user
daemon-reload`, enables and starts `vertebrae-daemon`, and logs to
`~/.local/state/vertebrae/logs/{daemon.log,daemon.error.log}`.

### Daemon Uninstall Options

```bash
vtb daemon uninstall [OPTIONS]
```

| Flag | Description |
|------|-------------|
| `--json` | Appears in generated help but is currently ignored for daemon commands; output remains human-readable |
| `-h, --help` | Print command help |

`vtb daemon uninstall` has no aliases, positional arguments, command-specific
flags, short flags, defaults, or value enums. On macOS, it checks for
`~/Library/LaunchAgents/com.vertebrae.daemon.plist`; on Linux, it checks for
`~/.config/systemd/user/vertebrae-daemon.service`. If no service file exists,
the command is a no-op and reports that `vtb-daemon` is not installed.

When installed, the command unregisters the user service through the platform
service manager and removes the service file. On success, it reports the
removed plist or systemd unit path and notes that the daemon will no longer
start on login. Service-manager or filesystem failures are surfaced as command
errors from the shared installer layer.
