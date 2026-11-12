## Part: projection

Choose when the mechanism folds events into a read model. Family: event sourcing; footprint: L.

Props:

- `applied`: `{"type":"integer","min":0,"default":3}`

Ports:

- `in`: in, W; tokens: `event` — event

### projection.fold

the handler applies one event to the read model Card: required; tokens: event; default duration: 1.1 s.

Arguments:

None.

### projection.record

an event arrives while the handler is stuck and waits Card: required; tokens: event; default duration: 0.8 s.

Arguments:

None.

### projection.fail

the handler throws: the checkpoint stops at the last applied event and the lag grows Card: required; tokens: event; default duration: 1.3 s.

Arguments:

None.

### projection.replay

wipe the read model and fold every event again from #0 Card: none; tokens: any; default duration: 3.2 s.

Arguments:

- `events`: `{"type":"integer","min":1,"max":12,"default":6}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
