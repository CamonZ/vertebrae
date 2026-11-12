## Part: approval

Choose when the mechanism waits for a person. Family: policy; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `request`
- `out`: out, E; tokens: `request` — request (approved)
- `person`: in, N; tokens: `control` — person rail (approve, reject)

### approval.wait

the request arrives and waits for a person Card: required; tokens: request; default duration: 1.2 s.

Arguments:

None.

### approval.approve

the person says yes: the gate lifts and the request leaves Card: required; tokens: request; default duration: 1.2 s.

Arguments:

None.

### approval.reject

the person says no: the request goes back Card: required; tokens: request; default duration: 1.2 s.

Arguments:

None.

### approval.expire

nobody answers before the deadline Card: required; tokens: request; default duration: 1 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
