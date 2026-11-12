## Part: transform

Choose when the mechanism changes the shape. Family: compute; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `data`, `payload`, `request`
- `out`: out, E; tokens: `data`

### transform.transform

stamp the card into a new shape; it leaves as data Card: required; tokens: data, payload, request; default duration: 1 s.

Arguments:

- `to`: `{"type":"string"}` — the new shape, e.g. Task
- `outcome`: `{"type":"string","enum":["ok","error"],"default":"ok"}`
- `reason`: `{"type":"string","default":"bad field"}`

### transform.fail

Report a shape-conversion failure with the supplied reason. Card: none; tokens: any; default duration: 0.6 s.

Arguments:

- `reason`: `{"type":"string","default":"bad field"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
