## Part: shard ring

Choose when the mechanism maps each key to one node. Family: distributed systems; footprint: L.

Props:

None.

Ports:

None.

### shard ring.route

Find the first ring owner clockwise from the supplied angle, wrapping at the end. Card: optional; tokens: any; default duration: 0.7 s.

Arguments:

- `angle`: `{"type":"number","min":0,"max":359.999,"default":100}`

### shard ring.rebalance

Add node D once and move the illustrated range of load from B to D. Card: optional; tokens: any; default duration: 1 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
