## Part: two-phase commit

Choose when the mechanism all commit or none do. Family: distributed systems; footprint: L.

Props:

None.

Ports:

- `in`: in, W; tokens: `request`
- `p1`: both, E; tokens: `control`, `signal`
- `p2`: both, E; tokens: `control`, `signal`
- `p3`: both, E; tokens: `control`, `signal`

### two-phase commit.stage

Begin prepare and ask all three participants to vote. Card: optional; tokens: any; default duration: 1.1 s.

Arguments:

None.

### two-phase commit.vote

Record a yes or no vote from the selected participant. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

- `participant`: `{"type":"integer","min":1,"max":3,"default":1}`
- `yes`: `{"type":"boolean","default":true}`

### two-phase commit.commit

Commit only with three yes votes and a live coordinator; emit a commit checkpoint. Card: optional; tokens: any; default duration: 0.7 s.

Arguments:

None.

### two-phase commit.rollback

Abort all participants and release their locks. Card: optional; tokens: any; default duration: 0.7 s.

Arguments:

None.

### two-phase commit.fail

Crash the coordinator and leave the transaction blocked with locks held. Card: optional; tokens: any; default duration: 0.5 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
