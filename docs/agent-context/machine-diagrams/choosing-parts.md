# Choosing parts

Use the [reference](../machine-diagrams-reference.md) for each kind's job,
exact registered spelling, ports, props and verbs. Choose the mechanism that
answers the question rather than putting every component on screen.

Use `source` or `client` for inputs; `worker` for a job; `transform` for a shape
change; `router`, `splitter`, `joiner`, `aggregator`, `pipeline` and `pool` for
distribution and coordination. Use `store`, `cache`, `document`, `schema`,
`state machine`, `reactive cell`, `transaction` and `lock` when the data or
consistency mechanism is the point. Use `session`, `guard` and `boundary` for
lifetime, permission and crossing a boundary. `event rail`, `queue`, `retry`,
`timeout`, `rate limiter` and `circuit breaker` explain delivery and resilience.
`approval`, `metric`, `trace` and `alert` explain people and observation.

For event sourcing choose `event store`, `decider`, `projection`, `snapshot`,
`replay`, `upcaster`, `saga`, `outbox`, `consumer offset` or `idempotency guard`.
Distributed mechanisms include `replication`, `quorum`, `leader election`,
`failure detector`, `gossip`, `shard ring`, `version vector`, `fencing token`,
`two-phase commit` and `service registry`.

Use `task run` for a durable-run overview; choose `inference step`,
`structured step`, `execute step`, `route step`, `wait children`, `human gate`
or `run end` when explaining a particular workflow step. These parts illustrate
operations; their verbs do not invoke a provider, script or backend mutation.

[Authoring index](../machine-diagrams.md).
