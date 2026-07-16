# Harness core durable event contract

`vertebrae-harness-core` defines the provider-neutral runtime, event, and replay
contracts shared by interactive sessions and one-shot runs. Provider adapters
translate their wire protocols into `HarnessEventV1`; persistence and UI
consumers must not depend on provider wire shapes.

## Durable identities and ordering

The identifiers in `HarnessEventV1` have distinct scopes:

- `event_id` identifies one event globally and is the idempotency key for
  persistence and projection.
- `session_id` identifies one logical interactive session. Resuming a provider
  session retains this value. It is normally absent from one-shot runs.
- `thread_id` identifies one logical root or subagent conversation within a
  session. It is stable when that thread is delivered through another stream.
- `run_id` identifies one invocation of `run_once`. Every event emitted for the
  invocation, including `turn_input` and `run_finished`, carries that value.
- `stream_id` identifies one ordered delivery stream. Sequence numbers start at
  1 and increase contiguously within that stream only.

Each `stream_id` binds to at most one `session_id`, one logical `thread_id`, and
one one-shot `run_id`. Producers must not multiplex root and child threads, two
sessions, or two one-shot runs through the same stream. The projector diagnoses
and excludes an event whose correlation conflicts with an established stream
binding. A logical `thread_id`, conversely, may be observed in multiple streams
when its session is resumed.

An interactive session resume always creates a new `stream_id` and restarts its
sequence at 1 while retaining `session_id` and the applicable logical
`thread_id` values. A stream ID is never reused for a retry or resume.

Replay is a partial order: deduplicate globally by `event_id`, group by
`stream_id`, and apply each group by `sequence`. Neither timestamps nor
`provider_sequence` establish order between streams. Consumers must preserve
stream boundaries rather than interleave resumed streams heuristically. The
thread catalog exposes every stream observed for a logical thread; a surface
that needs a total presentation order across resume epochs must retain that
external persistence metadata separately from `HarnessEventV1`.

## Input authorship

`turn_input` stores exact, unabridged input. `turn_started.input_summary` is
display metadata and is not a durable substitute. Its `data.thread_id` and
optional `data.run_id` are the durable canonical identities. Copies in event
correlation are routing/index metadata and, when present, must agree with the
payload. This redundancy allows a pre-change V1 reader to preserve the required
identity while treating `turn_input` as an unknown type. Provenance has four
values:

- `human` for direct user input;
- `agent` for instructions authored by a parent agent, including subagent
  prompts (these must not be presented as human-authored messages);
- `system` for orchestrator or system instructions;
- `provider` for provider-generated input material.

Interactive turn inputs carry `session_id`, `thread_id`, and `turn_id`.
One-shot inputs carry `run_id` and their logical `thread_id`; they may omit
`session_id` and `turn_id`.

## Thread declarations and replay

`thread_declared` establishes root/subagent lineage. Its correlation
`thread_id` must equal the payload `thread_id`, and all declarations of the same
logical thread must agree on identity, kind, parent, and provider locator. Root
threads have no parent or causing tool call. A subagent declaration points to
its parent and, when available, the tool call that created it. Lineage is
acyclic, a thread cannot parent itself, and parent and child belong to the same
session. A child may be declared before its parent; its unresolved lineage is
valid until the parent arrives. A newly arriving declaration that reveals a
cycle or session mismatch is diagnosed and excluded, leaving earlier catalog
state intact. The first valid declaration applied to a projector remains
canonical. Valid logs agree across streams. For malformed logs, consumers must
not infer a semantic cross-stream order from which conflicting declaration
happened to arrive first.

`provider_thread_ref` is an opaque provider-owned loading handle. Persist and
return it verbatim; do not parse it, compare its internal structure, or put it
in `provider_resume_id`. A Codex child-thread locator and a Claude subagent
transcript locator have different loading semantics even when both happen to
look like IDs.

`HarnessProjection` builds a thread catalog containing declarations and the
set of streams observed for each logical thread. Events remain in their
original `StreamProjection`; child and grandchild events are never copied into
the parent conversation.

## Usage aggregation

`usage` is the only event type that contributes to aggregate usage:

- `turn_delta` is additive and contributes once after `event_id`
  deduplication;
- `session_snapshot` replaces the current session/context snapshot.

The `usage` fields on `turn_finished` and `run_finished` are informational
terminal summaries. They must never be added to totals, because providers may
repeat usage already emitted as `usage` events.

Terminal one-shot outcomes also settle all pending controls in their stream.
Completed, interrupted, and cancelled runs cancel unresolved controls. Failed
runs use the request's automatic fallback decision when one exists. Because a
stream cannot switch run identity, a terminal outcome cannot settle controls
belonging to another run. `StreamProjection.run_outcomes`, keyed by `run_id`, is
canonical; `run_outcome` is only the compatibility/latest view for older
callers.

## Runtime configuration boundary

`RequestConfig` contains portable, per-request behavior: working directory,
model selection, reasoning effort, output schema, and request environment.
Provider-specific runtime construction stays in the adapter constructor. This
includes executable paths, launch arguments, app-server or API endpoints,
credentials, protocol clients, provider feature flags, and permission/control
plumbing. Do not tunnel those settings through `RequestConfig` or encode them
as provider-specific event data.

## V1 extensibility

New neutral payloads remain additive inside the existing V1 `type` plus `data`
wire envelope. Readers that predate `turn_input` or `thread_declared` preserve
their opaque `type` and `data`, so durable logs can be replayed after the reader
is upgraded. Such readers may discard correlation keys they do not recognize;
therefore required new `turn_input` identity is also stored inside `data`, while
`thread_declared` already carries its canonical thread identity there.
