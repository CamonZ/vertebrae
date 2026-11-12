## Part: task run

Choose when the mechanism one durable run through the steps. Family: vertebrae workflows; footprint: L.

Props:

- `steps`: `{"type":"string[]","default":["llm","execute","finish"]}` — the step types at the three stations, never step names

Ports:

- `in`: in, W; tokens: `payload`, `request`, `data` — the TaskRun

### task run.start

the TaskRun is queued, then executes its first step Card: required; tokens: payload, request, data; default duration: 1 s.

Arguments:

None.

### task run.stage

the step at this station ends and the run moves to the next one Card: none; tokens: any; default duration: 1.3 s.

Arguments:

None.

### task run.wait

the step parks the run (a gate, child tasks) until something answers Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

### task run.finish

the last step ends and the TaskRun completes Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

### task run.fail

a step fails and the TaskRun fails with the reason saved Card: none; tokens: any; default duration: 1 s.

Arguments:

None.

### task run.stop

stop-taskrun parks the run: a stopped card is dimmed, not a new colour Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
