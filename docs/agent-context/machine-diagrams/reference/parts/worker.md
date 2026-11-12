## Part: worker

Choose when the mechanism runs one job. Family: compute; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `request`, `data`, `payload`
- `out`: out, E; tokens: `result`
- `ctl`: in, N; tokens: `control`

### worker.stage

Clamp the incoming job in the worker and begin working. Card: required; tokens: request, data, payload; default duration: 0.75 s.

Arguments:

None.

### worker.finish

Release the held job after optional work time; a supplied card exits as a result with the same identity. Card: optional; tokens: any; default duration: 0.6 s.

Arguments:

- `work`: `{"type":"number","min":0,"default":0}`

### worker.fail

End the held job and report the failure reason. Card: none; tokens: any; default duration: 0.6 s.

Arguments:

- `reason`: `{"type":"string","default":"exit 1"}`

### worker.cancel

End the held job, optionally accepting a cancel control card, and consume that card. Card: optional; tokens: control; default duration: 0.6 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
