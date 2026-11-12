## Part: event store

Choose when the mechanism appends facts, never edits. Family: event sourcing; footprint: L.

Props:

- `events`: `{"type":"integer","min":0,"max":7,"default":4}`

Ports:

- `in`: in, W; tokens: `request`, `data`, `payload`, `control` — command (append, expected version)
- `out`: out, E; tokens: `event`, `data`, `result` — event (read from a version)

### event store.append

write one event at the head, expecting the head version Card: required; tokens: request, data, payload, control; default duration: 1.7 s.

Arguments:

None.

### event store.fail

a writer expecting a stale version: it bounces back and nothing is written Card: required; tokens: request, data, payload, control; default duration: 1.9 s.

Arguments:

- `expect`: `{"type":"integer","min":0}` — the version the writer expected (default: one behind)

### event store.read

read the events from a version to the head; they leave E Card: none; tokens: any; default duration: 1.2 s.

Arguments:

- `from`: `{"type":"integer","min":1,"default":1}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
