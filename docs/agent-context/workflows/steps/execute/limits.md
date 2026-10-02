# Execute limits and cancellation

Purpose: understand Rhai worker capacity, how scripts and their commands stop.
Use this when: overflow, limits, cancellation, isolation, commands, or provider setup.

Admission is daemon-wide and shared by every project: one active evaluation and
four pending attempts by default, set by `[daemon]` `script_active_slots` and
`script_pending_slots` ([config](../../../setup/config.md)). With one active slot,
a long script holds up every other execute step. Overflow fails explicitly.
Work runs off Tokio async workers; cancellation stops evaluation and any
in-flight host call, and the worker settles before capacity is released or a
terminal result is persisted. Cancelled queued jobs never evaluate.

There are no limits: no deadline, operation limit, or script, context, result,
string or collection size cap. Rhai's default expression and call depth guards
stay. Cancellation is the only way to stop a long or stuck script. The schema
validator compiles once inside the admitted blocking worker.
Compilation/validation cannot be interrupted by Rhai callbacks: cancellation is
checked around these phases, and capacity is retained until the worker settles.
The entire context is checked before queueing; it is never truncated. Context integers must be within
the signed 64-bit range (-9223372036854775808 through 9223372036854775807).
Larger JSON integers fail with their JSON pointer rather than being rounded to
floating point. Exact limits and ownership
are maintained in repository `docs/architecture.md` and
`crates/daemon/src/script_worker.rs`.

Scripts cannot load file modules or use dynamic eval. Host functions call
services directly from the worker thread, scoped to the execution's project,
and raise a catchable `#{ kind, message }` error (`not_found`, `invalid`,
`cancelled`, `transport`). Writes are not undone on failure or cancellation.
Each attempt uses a fresh Engine/Scope. Cancellation is cooperative; there is
no AST cache. Execute requires no provider binaries or credentials.

`vtb::cmd::run` commands run as the daemon user with its permissions and
environment, outside any sandbox. `PATH` is the user's login-shell PATH, as for
provider steps; pass `env` to add or override variables; an explicit `cwd` is not confined to the
worktree. A command has no timeout or output cap and holds its execute slot
until it exits, so with one active slot a long `cargo test` delays every other
execute step (inference steps are unaffected). Cancelling the step sends
SIGTERM to the command's process group, SIGKILL after a short grace period, and
reaps it before the slot is released; it raises `cancelled` and does not undo
side effects. Background processes a command leaves in its group are killed when
it exits.

TaskRun concurrency does not raise local worker capacity. Sacrum owns retries;
the worker does not select transitions or start new attempts.

## Related
[Settings](settings.md) · [Concurrency](../../../running/concurrency.md) ·
[Failure table](../../../debugging/failure-table.md)
