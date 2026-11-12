# Verbs, beats and captions

A verb belongs to its part kind. Do not transfer meaning or arguments between
kinds just because spelling matches. The [reference](../machine-diagrams-reference.md)
records whether a card is required, optional, or forbidden, accepted tokens,
default duration and allowed `args` including defaults and bounds.

Steps run in sequence. `with: true` starts a step with the previous step;
`delay` adds nonnegative seconds. `via` names a rail ending at this part;
the card must be at the source part (set its `origin` when needed), and ports
must accept its current token. Verbs can change a card's token while keeping
its identity, or consume it so it cannot travel farther. Prefer the same card
for a request becoming its result. `checkpoint` marks the end of the step.

`caption` is text or `{before: "…", after: "…"}`; either side may be omitted.
`hold` is nonnegative seconds after a beat (default 0.3 with steps, 1.6 for a
caption-only beat). Timing is illustrative unless measured evidence says
otherwise. Durations and holds do not make a scenario a recorded trace.

Important part-specific sequences, checked against their compile definitions:

- Queue: `send` seats a job or rejects it when full; `drain` delivers a waiting
  job; `retry` delivers, receives a nack, and returns that waiting job to the
  front (it remains queued). `fail` takes a waiting job to dead letter and
  consumes it. Do not drain a job before retrying it.
- Saga: `stage` succeeds at the next of three stations; the third emits a
  result. `wait` records an outstanding reply without advancing. `fail` stops
  at the next station (a pending wait makes it a deadline failure).
  `compensate` undoes completed stations backward, then resets the saga;
  it is explicit after failure, not an automatic effect of `fail`.
- Outbox: `record` consumes the command; `commit` adds a pending row.
  `publish` sends and normally marks it; `args: {marked: false}` models a
  crash after publishing. `fail` leaves it pending when the broker is down.
  `retry` republishes the oldest pending row and removes it, exposing a
  duplicate if already published. This is not exactly-once proof.
- Workflow arguments are illustrative inputs: `inference step.call` uses
  `tool` (`read`, `edit`, `test`), `structured step.ask` uses `questions`,
  `execute step.call` uses `host` and `op`, `route step.route`/`decide` use
  `rule` (`r1`, `r2`, `else`), and `wait children.wait` uses `child` (1–3) and
  `outcome` (`done`, `running`). Read the reference for all arguments and
  defaults; runtime step configuration is not a verb argument object.

[Authoring index](../machine-diagrams.md).
