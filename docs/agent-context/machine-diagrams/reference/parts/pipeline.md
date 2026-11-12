## Part: pipeline

Choose when the mechanism ordered stages. Family: compute; footprint: L.

Props:

- `stages`: `{"type":"string[]","default":["build","test","ship"]}`

Ports:

- `in`: in, W; tokens: `payload`, `request`, `data`
- `out`: out, E; tokens: `result`

### pipeline.stage

the card moves into the next stage Card: required; tokens: any; default duration: 1 s.

Arguments:

None.

### pipeline.finish

the last stage passed: the result leaves Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

None.

### pipeline.fail

Stop the held item with a failure at its current stage. Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

### pipeline.cancel

Cancel the held item, optionally carrying a control card. Card: optional; tokens: control; default duration: 0.5 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
