## Part: run end

Choose when the mechanism stop pauses, finish completes. Family: vertebrae workflows; footprint: S.

Props:

None.

Ports:

- `in`: in, W; tokens: `payload`, `request`, `data` — TaskRun
- `out`: out, E; tokens: `payload`, `request`, `data` — the next TaskRun continuing from a stop step
- `stop`: in, N; tokens: `control`; conditional/dashed — stop-taskrun

### run end.finish

the run crosses to the finish terminal and the task completes Card: required; tokens: payload, request, data; default duration: 1.1 s.

Arguments:

None.

### run end.stop

the run is parked: a stop step drops the bar, stop-taskrun stops it from outside Card: required; tokens: payload, request, data; default duration: 1.3 s.

Arguments:

- `by`: `{"type":"string","enum":["step","user"],"default":"step"}`

### run end.resume

a new TaskRun starts and continues from the stop step Card: required; tokens: payload, request, data; default duration: 1.3 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
