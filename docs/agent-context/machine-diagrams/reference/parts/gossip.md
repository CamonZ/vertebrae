## Part: gossip

Choose when the mechanism spreads news peer to peer. Family: distributed systems; footprint: L.

Props:

None.

Ports:

None.

### gossip.send

Reset knowledge so only node 1 has the news. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

### gossip.spread

Spread news from one numbered node to another if the sender knows it. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

- `from`: `{"type":"integer","min":1,"max":6,"default":1}`
- `to`: `{"type":"integer","min":1,"max":6,"default":2}`

### gossip.fail

Partition the illustrated nodes while preserving the known-node count. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
