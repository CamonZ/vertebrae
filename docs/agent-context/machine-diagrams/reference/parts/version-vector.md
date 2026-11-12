## Part: version vector

Choose when the mechanism spots concurrent writes. Family: distributed systems; footprint: L.

Props:

None.

Ports:

- `in`: in, W; tokens: `data`, `request`

### version vector.record

Stage a write with the supplied A and B version counters. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

- `a`: `{"type":"integer","min":0,"max":1000000,"default":1}`
- `b`: `{"type":"integer","min":0,"max":1000000,"default":1}`

### version vector.compare

Compare the pending vector with the stored one: supersede, ignore an older write, or retain concurrent siblings. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

None.

### version vector.merge

Merge component maxima, increment B, and replace siblings with the merged value. Card: optional; tokens: any; default duration: 0.5 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
