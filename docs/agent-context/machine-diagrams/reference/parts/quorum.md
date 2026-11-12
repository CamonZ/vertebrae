## Part: quorum

Choose when the mechanism needs a majority to agree. Family: distributed systems; footprint: L.

Props:

None.

Ports:

- `in`: in, W; tokens: `request`, `data`
- `r1`: both, E; tokens: `request`, `signal`
- `r2`: both, E; tokens: `request`, `signal`
- `r3`: both, E; tokens: `request`, `signal`

### quorum.replicate

Reset acknowledgments and send a write to three replicas. Card: optional; tokens: any; default duration: 1.1 s.

Arguments:

None.

### quorum.ack

Record one distinct replica acknowledgment and advance its displayed version. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

- `replica`: `{"type":"integer","min":1,"max":3,"default":1}`

### quorum.decide

Succeed with at least two distinct acknowledgments, otherwise fail the write. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

### quorum.fail

Explicitly report a failed write without quorum. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
