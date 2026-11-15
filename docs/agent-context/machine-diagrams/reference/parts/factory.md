## Part: factory

Choose when the mechanism a whole factory as one station. Family: vertebrae workflows; footprint: M.

Props:

- `workflows`: `{"type":"integer[]","min":1,"max":20,"default":[3,5]}` — the step count of each workflow, in factory order, 1–20 workflows; never workflow names
- `inbound`: `{"type":"string[]","default":[]}` — factories that hand work to this one (Atlas factory routes)
- `outbound`: `{"type":"string[]","default":[]}` — factories this one hands work to (Atlas factory routes)
- `parked`: `{"type":"integer","min":0,"max":8,"default":0}` — other TaskRuns already parked (amber chips)
- `active`: `{"type":"integer","min":0,"max":8,"default":0}` — other TaskRuns already active (ink chips)

Ports:

- `in1`…`in4`: in, W; tokens: `payload`, `request`, `data`, `result` — one per inbound factory; `in` alone when there is none
- `out1`…`out4`: out, E; tokens: `payload`, `request`, `data`, `result` — one per outbound factory

Past four factories on a side, port 4 bundles the rest (`+k more`). There are no finished or needs-attention exits.

### factory.enter

a task enters from an inbound factory (its port lights) or by the lone entry, and the first workflow works Card: required; tokens: payload, request, data, result; default duration: 1 s.

Arguments:

- `from`: `{"type":"string"}` — the inbound factory; defaults to the port it arrived on, else the first

### factory.step

the working workflow completes and the task hops to the next workflow mark (or to workflow `to`); after a wait it resumes first Card: none; tokens: any; default duration: 0.6 s.

Arguments:

- `to`: `{"type":"integer","min":1,"max":20}` — 1-based workflow the task moves to (default: the next)

### factory.wait

the working workflow parks (a gate or child tasks inside it) until a step answers it Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

### factory.hand off

the task leaves for another factory by that factory's out port (bundled factories by the bundle port) Card: required; tokens: payload, request, data, result; default duration: 1 s.

Arguments:

- `to`: `{"type":"string"}` — the outbound factory; defaults to the first

### factory.finish

the working workflow completes the task: it sinks into the mark (task done) Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

### factory.fail

the working workflow fails: red mark, the card and chip stay red, the task needs attention Card: none; tokens: any; default duration: 1 s.

Arguments:

- `reason`: `{"type":"string"}` — short reason tagged under the card

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
