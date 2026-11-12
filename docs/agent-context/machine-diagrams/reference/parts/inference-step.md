## Part: inference step

Choose when the mechanism one agent turn. Family: vertebrae workflows; footprint: M.

Props:

- `harness`: `{"type":"string","default":"claude"}` — the harness running the turn (claude, codex, mistral vibe)

Ports:

- `in`: in, W; tokens: `payload`, `data`, `request` — prompt (context)
- `out`: out, E; tokens: `result` — output
- `tools`: both, N; tokens: `signal`; conditional/dashed — tool calls to the tools box

### inference step.stage

the prompt seats in the press and the agent starts Card: required; tokens: payload, data, request; default duration: 0.75 s.

Arguments:

None.

### inference step.call

the agent calls a tool in the tools box and gets the result Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `tool`: `{"type":"string","enum":["read","edit","test"],"default":"read"}`

### inference step.validate

the output is checked against the step's schema Card: none; tokens: any; default duration: 0.3 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","invalid"],"default":"ok"}`

### inference step.finish

the turn ends and the output leaves as a result Card: optional; tokens: any; default duration: 0.7 s.

Arguments:

- `work`: `{"type":"number","min":0,"default":0}`

### inference step.fail

the turn fails: the output does not fit the schema Card: none; tokens: any; default duration: 0.7 s.

Arguments:

- `reason`: `{"type":"string","default":"output fails schema"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
