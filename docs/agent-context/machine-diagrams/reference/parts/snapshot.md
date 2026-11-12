## Part: snapshot

Choose when the mechanism skips the replay. Family: event sourcing; footprint: L.

Props:

- `events`: `{"type":"integer","min":1,"max":8,"default":8}`
- `snapshot`: `{"type":"integer","min":0,"max":8,"default":6}`

Ports:

None.

### snapshot.read

load the snapshot and fold only the events after it into the state Card: none; tokens: any; default duration: 2.6 s.

Arguments:

None.

### snapshot.replay

fold every event from the first one (no snapshot to skip with) Card: none; tokens: any; default duration: 4 s.

Arguments:

None.

### snapshot.snapshot

save the state as a snapshot covering every event so far Card: none; tokens: any; default duration: 2.4 s.

Arguments:

None.

### snapshot.fail

the snapshot is unreadable: it is dropped and the next read replays everything Card: none; tokens: any; default duration: 1.8 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
