## Part: leader election

Choose when the mechanism picks one leader per term. Family: distributed systems; footprint: L.

Props:

None.

Ports:

None.

### leader election.elect

Begin a new term with the selected candidate and its own vote. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

- `node`: `{"type":"integer","min":1,"max":5,"default":1}`

### leader election.vote

Record a distinct node vote; three of five votes elect the candidate. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

- `node`: `{"type":"integer","min":1,"max":5,"default":2}`

### leader election.heartbeat

Send heartbeats from the elected leader, or report that no leader exists. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

None.

### leader election.fail

End the election without a majority and clear the leader. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
