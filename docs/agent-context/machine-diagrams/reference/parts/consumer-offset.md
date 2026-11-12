## Part: consumer offset

Choose when the mechanism remembers how far it read. Family: event sourcing; footprint: L.

Props:

- `committed`: `{"type":"integer","min":0,"max":7,"default":3}`

Ports:

None.

### consumer offset.read

read the next event from the log; the pointer moves on Card: none; tokens: any; default duration: 0.9 s.

Arguments:

None.

### consumer offset.process

the consumer handles the event it just read Card: none; tokens: any; default duration: 0.5 s.

Arguments:

None.

### consumer offset.commit

store the offset: every event up to it counts as done, even one not yet processed Card: none; tokens: any; default duration: 0.9 s.

Arguments:

- `upTo`: `{"type":"integer","min":1,"max":8}` — the offset to commit (default: how far it has read)

### consumer offset.fail

the consumer crashes and restarts from the committed offset: events read after it are read again (or, if committed early, never processed) Card: none; tokens: any; default duration: 1.8 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
