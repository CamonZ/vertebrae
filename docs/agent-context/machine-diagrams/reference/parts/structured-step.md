## Part: structured step

Choose when the mechanism asks typed questions. Family: vertebrae workflows; footprint: M.

Props:

- `provider`: `{"type":"string","default":"typesafe"}` — who answers the questions

Ports:

- `in`: in, W; tokens: `payload`, `data`, `request` — state and questions (context)
- `out`: out, E; tokens: `data` — typed answer

### structured step.ask

the state and questions seat in the answer hole; each answer lights a lamp Card: required; tokens: payload, data, request; default duration: 2 s.

Arguments:

- `questions`: `{"type":"integer","min":1,"max":3,"default":3}`

### structured step.validate

the typed answer is checked against its schema Card: none; tokens: any; default duration: 0.7 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","invalid"],"default":"ok"}`
- `question`: `{"type":"integer","min":1,"max":3,"default":3}`

### structured step.finish

the answer passes the check and leaves as data Card: optional; tokens: any; default duration: 1 s.

Arguments:

None.

### structured step.fail

an answer is rejected and the step fails Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `reason`: `{"type":"string","default":"answer rejected"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
