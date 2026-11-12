## Part: circuit breaker

Choose when the mechanism fails fast when broken. Family: messaging and flow control; footprint: M.

Props:

- `threshold`: `{"type":"integer","min":1,"max":3,"default":3}`

Ports:

- `in`: in, W; tokens: `request`
- `out`: out, E; tokens: `request` — request (closed only)

### circuit breaker.send

closed: the call goes through; open: it fails fast Card: required; tokens: request; default duration: 1 s.

Arguments:

None.

### circuit breaker.fail

a call failed: counts toward the threshold; a failed trial reopens Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

### circuit breaker.trip

force the blade open and start the cool-down Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

### circuit breaker.probe

half-open: one trial call goes through Card: optional; tokens: request; default duration: 1 s.

Arguments:

None.

### circuit breaker.reset

the trial succeeded: the blade closes Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
