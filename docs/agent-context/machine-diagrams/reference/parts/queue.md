## Part: queue

Choose when the mechanism first in, first out. Family: messaging and flow control; footprint: L.

Props:

- `slots`: `{"type":"integer","min":1,"max":5,"default":5}`

Ports:

- `in`: in, W; tokens: `request`, `batch`, `data`, `payload`
- `out`: out, E; tokens: `request`, `data`, `payload`
- `dead`: out, S; tokens: `request`, `data`, `payload` — dead-letter bin

### queue.send

a job takes the next slot, or is rejected when full Card: required; tokens: request, batch, data, payload; default duration: 0.6 s.

Arguments:

None.

### queue.wait

Hold for the supplied seconds and report how many jobs are waiting. Card: none; tokens: any; default duration: 1 s.

Arguments:

- `seconds`: `{"type":"number","min":0,"default":1}`

### queue.drain

the consumer takes a waiting job; the rest move forward Card: required; tokens: any; default duration: 0.8 s.

Arguments:

None.

### queue.retry

the consumer rejects a delivery: the job goes back to the front Card: required; tokens: any; default duration: 1.6 s.

Arguments:

None.

### queue.fail

the job runs out of tries and goes to the dead-letter bin Card: required; tokens: any; default duration: 0.9 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
