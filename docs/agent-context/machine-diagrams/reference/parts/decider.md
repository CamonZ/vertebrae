## Part: decider

Choose when the mechanism command + state → events. Family: event sourcing; footprint: M.

Props:

- `state`: `{"type":"string","default":"balance 50"}`

Ports:

- `in`: in, W; tokens: `request`, `control`, `data` — command
- `out`: out, E; tokens: `event`, `result` — event(s)

### decider.decide

the command meets the state and produces events, or none when nothing changes Card: required; tokens: request, control, data; default duration: 2.7 s.

Arguments:

- `events`: `{"type":"integer","min":0,"default":1}`
- `state`: `{"type":"string"}` — the state line after the decision

### decider.fail

the command breaks an invariant: it bounces back and no events are produced Card: required; tokens: request, control, data; default duration: 2.9 s.

Arguments:

- `reason`: `{"type":"string","default":"invariant broken"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
