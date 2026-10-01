# Execute limits and cancellation

Purpose: understand bounded Rhai work and its local capacity.
Use this when: overflow, limits, deadline, cancellation, isolation, or provider setup.

Admission is daemon-wide: one active evaluation and four pending attempts.
Overflow fails explicitly. Work runs off Tokio async workers; cancellation and
the cooperative deadline stop evaluation, and the worker settles before capacity
is released or a terminal result is persisted. Cancelled queued jobs never evaluate.

Default bounds include a 256 KiB script, 1 MiB each of JSON context/schema/result,
100,000 operations, and a two-second deadline starting at admission, including
queue time and schema compilation. The schema validator compiles once inside
the admitted blocking worker. Compilation/validation cannot be interrupted by
Rhai callbacks: cancellation and deadlines are checked around these phases,
and capacity is retained until the worker settles. Strings,
containers, nesting and calls have finite bounds too. The entire context is
checked before queueing; it is never truncated. Context integers must be within
the signed 64-bit range (-9223372036854775808 through 9223372036854775807).
Larger JSON integers fail with their JSON pointer rather than being rounded to
floating point. Exact limits and ownership
are maintained in repository `docs/architecture.md` and
`crates/daemon/src/script_worker.rs`.

The PoC is pure JSON transformation: no module loading, dynamic eval, host
filesystem/process functions, artifact reads, or shell commands. Each attempt
uses a fresh Engine/Scope. Limits and cancellation are cooperative; there is no
process isolation or AST cache. Execute requires no provider binaries or credentials.

TaskRun concurrency does not raise local worker capacity. Sacrum owns retries;
the worker does not select transitions or start new attempts.

## Related
[Settings](settings.md) · [Concurrency](../../../running/concurrency.md) ·
[Failure table](../../../debugging/failure-table.md)
