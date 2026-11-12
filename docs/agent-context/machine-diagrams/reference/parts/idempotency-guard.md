## Part: idempotency guard

Choose when the mechanism applies each key once. Family: event sourcing; footprint: M.

Props:

- `seen`: `{"type":"string[]","default":["k3","k5"]}`

Ports:

- `in`: in, W; tokens: `request` — request (key)
- `out`: out, E; tokens: `request` — request (to the effect)

### idempotency guard.dedupe

check the key: a new one goes on to the effect, one already seen gets the stored result back Card: required; tokens: request; default duration: 1.8 s.

Arguments:

- `key`: `{"type":"string"}` — default: the card label

### idempotency guard.wait

the same key arrives while the first request is still being applied: it waits at the check Card: required; tokens: request; default duration: 1.2 s.

Arguments:

- `key`: `{"type":"string"}` — default: the card label

### idempotency guard.record

the effect finished: the key is stored as seen with its result, and any waiting request gets that result Card: none; tokens: any; default duration: 1.2 s.

Arguments:

- `key`: `{"type":"string"}` — default: the key in flight

### idempotency guard.expire

a seen key ages out: the same key looks new the next time it arrives Card: none; tokens: any; default duration: 0.9 s.

Arguments:

- `key`: `{"type":"string"}` — default: the first seen key

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
