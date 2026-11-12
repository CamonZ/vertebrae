## Part: boundary

Choose when the mechanism crossing costs a hop. Family: topology and lifecycle; footprint: L.

Props:

- `region`: `{"type":"string"}` — region name, e.g. a process or network

Ports:

- `in`: in, W; tokens: `request`, `payload`, `data`
- `out`: out, E; tokens: `request`, `payload`, `data` — inside: the call delivered to the handler

### boundary.cross

serialize the card across the edge (one hop) Card: required; tokens: any; default duration: 1.2 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","refused","partition"],"default":"ok"}`
- `reason`: `{"type":"string","default":"untrusted"}`

### boundary.spawn

Show the instance coming up. Card: none; tokens: any; default duration: 0.5 s.

Arguments:

None.

### boundary.close

Show the instance going down. Card: none; tokens: any; default duration: 0.5 s.

Arguments:

None.

### boundary.fail

Show the failure reason at the boundary; no crossing is performed. Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `reason`: `{"type":"string","default":"caller gets no reply"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
