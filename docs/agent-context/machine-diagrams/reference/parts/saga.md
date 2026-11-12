## Part: saga

Choose when the mechanism steps forward, undoes backward. Family: event sourcing; footprint: L.

Props:

None.

Ports:

- `in`: in, W; tokens: `event`, `request` — event (start)
- `out`: out, E; tokens: `result` — result
- `undo`: out, W; tokens: `result`, `control`; conditional/dashed — undo lane

### saga.stage

run the next step: the card crosses to its station and the step succeeds; after the last step the result leaves Card: required; tokens: event, request; default duration: 1.2 s.

Arguments:

None.

### saga.wait

a step has been asked and no reply has come yet Card: none; tokens: any; default duration: 1.6 s.

Arguments:

None.

### saga.fail

the step does not succeed (an error, or the deadline passes with no reply); the card stops at its station Card: none; tokens: any; default duration: 1.4 s.

Arguments:

None.

### saga.compensate

undo the completed steps backward along the undo lane, releasing each lamp Card: none; tokens: any; default duration: 3.2 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
