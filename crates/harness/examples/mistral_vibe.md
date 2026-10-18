# Mistral Vibe protocol diagnostic

This standalone Rust example tests the Vibe 2.26.1 app-server protocol. It is a
narrow diagnostic for adapter behavior; the production workflow harness is the
`mistral_vibe` selector backed by `vertebrae-harness-mistral-vibe`.

From the repository root, with `vibe-app-server` 2.26.1 installed on `PATH` and
`MISTRAL_API_KEY` supplied through your shell or credential manager:

```sh
cargo run --locked -p vertebrae-harness --example mistral_vibe -- 'Reply with exactly: Mistral Vibe diagnostic works'
```

Do not put the key in the command or source. The example inherits the caller's
environment but creates a disposable `VIBE_HOME` and working directory. It
does not load your usual Vibe `.env`, config, agents or project instructions.
Vibe uses its default model. To select an installed executable outside `PATH`,
set `MISTRAL_VIBE_SERVER` to its path (a single executable, not a shell command).
The example targets macOS/Linux; Windows process-tree behavior is not qualified.

The example initializes JSON-RPC, opens a fresh session with tools disabled,
submits the supplied text and assembles public assistant message updates,
including Vibe's string `append` patches. Final text goes to stdout once; version
and terminal outcome go to stderr. It rejects tools/callbacks and incomplete,
failed, refused or limited turns. There is no normalized event integration,
replay, resume, fork, model selection or structured output.

Startup is limited to 30 seconds and the turn to 120 seconds. Ctrl-C, EOF,
protocol errors and timeout all lead to bounded cleanup using the existing
process-group reaper. Session stop is best effort, followed by closing stdin,
waiting and escalating signals if necessary. Temporary directories are removed
on normal exit, including handled failures/Ctrl-C; SIGKILL or a process crash
cannot guarantee removal. No turn is retried. Records and retained response
data are limited to 1 MiB. Provider stderr and arbitrary error details are
discarded to avoid disclosing credentials; errors identify the failed stage.
The production harness adds daemon discovery, capability reporting, dynamic
model selection, normalized events, and workflow validation. This example remains
useful for isolating process/protocol failures without orchestration.

Run the deterministic process/protocol checks without Vibe or credentials:

```sh
cargo build --locked -p vertebrae-harness --example mistral_vibe
python3 -u crates/harness/examples/mistral_vibe_test.py target/debug/examples/mistral_vibe
# Also wait through the actual 120-second turn deadline:
python3 -u crates/harness/examples/mistral_vibe_test.py target/debug/examples/mistral_vibe --timeout
cargo clippy --locked -p vertebrae-harness --example mistral_vibe -- -D warnings
```

The small Python fake verifies handshake ordering, tool-disabled launch,
response IDs, text patches/order, error/refusal/limit handling, malformed and
oversize output, unexpected callbacks, EOF, Ctrl-C and cleanup. It checks the
server PID is gone and both temporary directories have been removed. The
optional timeout case exercises the same cleanup after the real deadline.

Protocol references are pinned to upstream
[2.26.1 protocol.py](https://github.com/mistralai/mistral-vibe/blob/v2.26.1/vibe/app_server/protocol.py),
[models.py](https://github.com/mistralai/mistral-vibe/blob/v2.26.1/vibe/app_server/models.py)
and [_patch.py](https://github.com/mistralai/mistral-vibe/blob/v2.26.1/vibe/app_server/_patch.py).
`initialize` actually returns `serverInfo`/`processId`, not the method/version
negotiation described by its ADR. Other Vibe versions are deliberately rejected.

Implementation evidence and limits belong on the ticket. A fake-server pass or
real handshake does not establish that an authenticated model turn works.
