## Part: execute step

Choose when the mechanism runs a Rhai script. Family: vertebrae workflows; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `payload`, `data`, `request` — context
- `out`: out, E; tokens: `data` — transformed data
- `host`: both, N; tokens: `signal`; conditional/dashed — host functions: tasks, artifacts, cmd

### execute step.transform

the script runs and the context leaves as valid output Card: required; tokens: payload, data, request; default duration: 1.6 s.

Arguments:

None.

### execute step.call

the script calls a host function and gets the reply Card: none; tokens: any; default duration: 0.9 s.

Arguments:

- `host`: `{"type":"string","enum":["tasks","artifacts","cmd"],"default":"artifacts"}`
- `op`: `{"type":"string","default":"read"}`

### execute step.fail

the script raises a runtime error and the step fails Card: required; tokens: payload, data, request; default duration: 1.6 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
