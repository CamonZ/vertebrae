## Part: guard

Choose when the mechanism allows or denies. Family: policy; footprint: S.

Props:

- `allow`: `{"type":"string[]","default":[]}`
- `reason`: `{"type":"string","default":"not allowed"}`

Ports:

- `in`: in, W; tokens: `request`
- `allow`: out, E; tokens: `request`
- `deny`: out, S; tokens: `result`, `request`; conditional/dashed

### guard.decide

Check the subject argument (or card label) against the allow list, unless outcome explicitly forces allow or deny. Card: required; tokens: request; default duration: 1.4 s.

Arguments:

- `subject`: `{"type":"string"}` — defaults to the card label
- `outcome`: `{"type":"string","enum":["allow","deny"]}` — force the outcome instead of checking `allow`

### guard.validate

Carry a card through the validator and mark it valid; this verb always exits through allow. Card: required; tokens: any; default duration: 1.2 s.

Arguments:

None.

### guard.fail

Show the policy failure reason. Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `reason`: `{"type":"string","default":"policy gap"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
