## Part: outbox

Choose when the mechanism saves and publishes together. Family: event sourcing; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `request`, `control`, `data` — command
- `out`: out, E; tokens: `event` — event (relay to broker)

### outbox.record

the command arrives and is handled inside one transaction Card: required; tokens: request, control, data; default duration: 0.8 s.

Arguments:

None.

### outbox.commit

state and the outbox row are written together Card: none; tokens: any; default duration: 1 s.

Arguments:

None.

### outbox.publish

the relay sends the pending message to the broker and marks the row; `marked: false` is a relay that crashes first Card: none; tokens: any; default duration: 2.4 s.

Arguments:

- `marked`: `{"type":"boolean","default":true}`

### outbox.retry

the relay restarts and sends the message that is still pending again Card: none; tokens: any; default duration: 2.8 s.

Arguments:

None.

### outbox.fail

the broker is down: the message comes back, stays in the outbox and will be retried Card: none; tokens: any; default duration: 2.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
