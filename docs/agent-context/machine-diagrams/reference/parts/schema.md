## Part: schema

Choose when the mechanism checks the shape. Family: data and state; footprint: M.

Props:

- `shape`: `{"type":"string","default":"{id, name}"}`

Ports:

- `in`: in, W; tokens: `data`, `payload`, `request`
- `out`: out, E; tokens: `data`, `payload` — valid data; invalid data stops at the check

### schema.validate

check a value: a fit crosses, a misfit stops at the check and goes back, an old version is upgraded and then fits Card: required; tokens: data, payload, request; default duration: 1.6 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","invalid","migrated"],"default":"ok"}`
- `reason`: `{"type":"string","default":"missing id"}`

### schema.decide

the check's verdict on its own, without moving a card Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","invalid"],"default":"ok"}`
- `reason`: `{"type":"string","default":"missing id"}`

### schema.fail

the check itself cannot run Card: none; tokens: any; default duration: 0.6 s.

Arguments:

- `reason`: `{"type":"string","default":"schema unavailable"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
