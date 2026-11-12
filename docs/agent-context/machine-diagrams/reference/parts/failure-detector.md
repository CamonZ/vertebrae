## Part: failure detector

Choose when the mechanism decides who is dead. Family: distributed systems; footprint: L.

Props:

None.

Ports:

- `heartbeat`: in, W; tokens: `signal`
- `status`: out, E; tokens: `signal`

### failure detector.heartbeat

Receive a heartbeat and reset the alive indicator. Card: optional; tokens: any; default duration: 0.5 s.

Arguments:

None.

### failure detector.wait

Show waiting for a heartbeat; this does not automatically suspect or fail the node. Card: optional; tokens: any; default duration: 0.7 s.

Arguments:

None.

### failure detector.suspect

Explicitly mark the node suspected after illustrative silence. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

### failure detector.fail

Declare the node dead and mark its crash. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
