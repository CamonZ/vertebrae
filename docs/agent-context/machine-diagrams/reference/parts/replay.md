## Part: replay

Choose when the mechanism rebuilds state from the first fact. Family: event sourcing; footprint: L.

Props:

None.

Ports:

None.

### replay.replay

fold the events from the first one up to now, or up to a version (an as-of read) Card: none; tokens: any; default duration: 3.8 s.

Arguments:

- `upTo`: `{"type":"integer","min":1,"max":5,"default":5}`

### replay.fold

fold the next event into the balance Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

### replay.fail

a handler changed since the events were written: the replayed value differs from the stored one Card: none; tokens: any; default duration: 3.2 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
