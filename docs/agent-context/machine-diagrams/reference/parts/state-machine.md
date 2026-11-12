## Part: state machine

Choose when the mechanism one state at a time. Family: data and state; footprint: L.

Props:

None.

Ports:

- `in`: in, W; tokens: `control`, `request`, `event` — an event (start, finish, error, cancel)

### state machine.stage

the start event: queued → running Card: optional; tokens: any; default duration: 0.9 s.

Arguments:

None.

### state machine.decide

an event picks one of the legal edges out of the current state Card: optional; tokens: any; default duration: 0.9 s.

Arguments:

- `to`: `{"type":"string","enum":["running","done","failed"],"default":"done"}`

### state machine.finish

the finish event: running → done Card: optional; tokens: any; default duration: 0.9 s.

Arguments:

None.

### state machine.fail

the error event: running → failed Card: optional; tokens: any; default duration: 0.9 s.

Arguments:

None.

### state machine.cancel

the cancel event: a running machine ends as failed; a finished one rejects it Card: optional; tokens: control, request, event; default duration: 0.9 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
