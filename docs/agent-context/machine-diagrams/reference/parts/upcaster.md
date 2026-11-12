## Part: upcaster

Choose when the mechanism reads old events as new. Family: event sourcing; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `event`, `data` — event (stored version)
- `out`: out, E; tokens: `event`, `data` — event (current version)

### upcaster.upcast

an event stored at an older version passes each upcast hole and leaves as the current version (3) Card: required; tokens: event, data; default duration: 2.8 s.

Arguments:

- `from`: `{"type":"integer","min":1,"max":3,"default":2}`

### upcaster.fail

an event stored at a version no upcaster covers bounces back unread Card: required; tokens: event, data; default duration: 2.2 s.

Arguments:

- `from`: `{"type":"integer","min":0,"default":0}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
