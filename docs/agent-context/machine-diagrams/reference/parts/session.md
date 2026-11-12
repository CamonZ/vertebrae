## Part: session

Choose when the mechanism lives across turns. Family: topology and lifecycle; footprint: S.

Props:

- `lifecycle`: `{"type":"string","enum":["persistent","one-shot"],"default":"persistent"}` — one-shot: a process per turn; persistent: one process kept between turns
- `launch`: `{"type":"string"}` — status text when a process starts

Ports:

- `turn`: in, W; tokens: `request`, `payload`
- `resume`: in, W; tokens: `control`; conditional/dashed — control (cancel, resume id)
- `out`: out, E; tokens: `result`, `request`, `event`

### session.connect

Start or resume the session process if needed. Card: none; tokens: any; default duration: 0.6 s.

Arguments:

None.

### session.stage

a turn: starts or resumes a process when none is live, then clamps the turn Card: required; tokens: request, payload; default duration: 0.55 s.

Arguments:

None.

### session.finish

the reply leaves; a one-shot session then closes its process Card: optional; tokens: any; default duration: 0.5 s.

Arguments:

None.

### session.cancel

interrupt the turn; a one-shot session closes its process Card: optional; tokens: control; default duration: 0.8 s.

Arguments:

None.

### session.close

close an idle process; a persistent session keeps its resume id Card: none; tokens: any; default duration: 0.9 s.

Arguments:

None.

### session.resume

Start a process if none is live, otherwise show the session still live; optionally carries resume control. Card: optional; tokens: control; default duration: 0.6 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
