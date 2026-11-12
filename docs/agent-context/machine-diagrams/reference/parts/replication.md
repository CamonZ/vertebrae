## Part: replication

Choose when the mechanism copies writes to followers. Family: distributed systems; footprint: L.

Props:

None.

Ports:

- `in`: in, W; tokens: `request`, `data`
- `f1`: out, E; tokens: `data`
- `f2`: out, E; tokens: `data`
- `ack`: in, E; tokens: `signal`

### replication.replicate

Increment the leader version and send copies to two followers. Card: optional; tokens: any; default duration: 1.2 s.

Arguments:

None.

### replication.ack

Record a distinct follower acknowledgment at the current version. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

- `follower`: `{"type":"integer","min":1,"max":2,"default":1}`

### replication.commit

Report catch-up; emit a checkpoint only when both followers have acknowledged. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

### replication.fail

Crash the leader and mark it down. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
