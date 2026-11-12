## Part: human gate

Choose when the mechanism parks for a person's answer. Family: vertebrae workflows; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `payload`, `request`, `data` — question
- `out`: out, E; tokens: `payload`, `request`, `data` — run resumes with the answer
- `reviewer`: in, N; tokens: `data`, `control`; conditional/dashed — reviewer lane (answer, stop)

### human gate.wait

the run parks in the gate and waits for a reviewer Card: required; tokens: payload, request, data; default duration: 1.2 s.

Arguments:

None.

### human gate.answer

the reviewer sets the answer and the answer artifact drops in Card: none; tokens: any; default duration: 0.9 s.

Arguments:

- `fits`: `{"type":"boolean","default":true}` — the answer fits the gate's schema

### human gate.validate

the answer is checked: a fit resumes the run, a miss keeps the gate open Card: optional; tokens: any; default duration: 1 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","invalid"]}` — defaults to what the attached answer implies

### human gate.stop

stop-taskrun arrives while the gate waits: the gate closes Card: none; tokens: any; default duration: 1 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
