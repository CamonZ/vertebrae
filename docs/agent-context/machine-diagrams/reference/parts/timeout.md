## Part: timeout

Choose when the mechanism stops waiting at a deadline. Family: messaging and flow control; footprint: M.

Props:

- `budget`: `{"type":"number","min":0,"default":2}`

Ports:

- `in`: in, W; tokens: `request`
- `out`: out, E; tokens: `request`, `result` — request (callee)
- `cancel`: out, S; tokens: `control`; conditional/dashed — cancel at the deadline

### timeout.wait

the caller's request seats and the fuse starts burning Card: required; tokens: request; default duration: 0.6 s.

Arguments:

None.

### timeout.tick

Wait the supplied seconds; answer: true releases a held caller and settles the fuse as answered in time. Card: none; tokens: any; default duration: 1 s.

Arguments:

- `seconds`: `{"type":"number","min":0,"default":1}`
- `answer`: `{"type":"boolean","default":false}` — the callee answers in time: the caller is released

### timeout.expire

the deadline passes: the caller stops waiting Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

### timeout.cancel

the deadline cancels the callee so nothing leaks Card: optional; tokens: control; default duration: 0.8 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
