## Part: aggregator

Choose when the mechanism many in, one out. Family: compute; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `data`, `batch`, `event`
- `out`: out, E; tokens: `data`

### aggregator.record

collect one item Card: required; tokens: any; default duration: 0.5 s.

Arguments:

- `bad`: `{"type":"boolean","default":false}` — the item will fail the reduce

### aggregator.reduce

the piston compresses the items Card: none; tokens: any; default duration: 0.35 s.

Arguments:

None.

### aggregator.flush

the one summary card leaves Card: optional; tokens: any; default duration: 0.65 s.

Arguments:

None.

### aggregator.fail

Mark the reduction failed with the supplied reason. Card: none; tokens: any; default duration: 0.6 s.

Arguments:

- `reason`: `{"type":"string","default":"bad item"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
