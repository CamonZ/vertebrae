## Part: splitter

Choose when the mechanism copies to every branch. Family: compute; footprint: S.

Props:

None.

Ports:

- `in`: in, W; tokens: `copy`, `data`, `event`, `request`, `payload`
- `b1`: out, E; tokens: `copy`, `data`, `event`, `request`, `payload`
- `b2`: out, E; tokens: `copy`, `data`, `event`, `request`, `payload`

### splitter.split

take one card in; its copies leave by `send` Card: required; tokens: any; default duration: 0.7 s.

Arguments:

- `copies`: `{"type":"integer","min":1,"default":2}`

### splitter.send

a copy leaves on its branch Card: required; tokens: any; default duration: 0.5 s.

Arguments:

- `branch`: `{"type":"string","enum":["b1","b2"],"required":true}`

### splitter.fail

a branch is down: its copy is not delivered Card: none; tokens: any; default duration: 0.5 s.

Arguments:

- `branch`: `{"type":"string","enum":["b1","b2"]}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
