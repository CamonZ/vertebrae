## Part: wait children

Choose when the mechanism parks for child tasks. Family: vertebrae workflows; footprint: M.

Props:

None.

Ports:

- `in`: in, W; tokens: `payload`, `request`, `data` — parent run
- `out`: out, E; tokens: `payload`, `data` — combined output of the children

### wait children.spawn

the parent parks in the slot and one child task is forked per ring Card: required; tokens: payload, request, data; default duration: 1 s.

Arguments:

None.

### wait children.wait

a child task finishes, or the run keeps waiting for one that has not Card: none; tokens: any; default duration: 0.7 s.

Arguments:

- `child`: `{"type":"integer","min":1,"max":3,"default":1}`
- `outcome`: `{"type":"string","enum":["done","running"],"default":"done"}`

### wait children.join

every child is done: the parent crosses to the check on the combined output Card: none; tokens: any; default duration: 0.7 s.

Arguments:

None.

### wait children.validate

the combined output is checked against the step's schema Card: optional; tokens: any; default duration: 0.9 s.

Arguments:

- `outcome`: `{"type":"string","enum":["ok","rejected"],"default":"ok"}`

### wait children.fail

a child returns no verdict and the step fails Card: none; tokens: any; default duration: 0.8 s.

Arguments:

- `reason`: `{"type":"string","default":"child failed"}`

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
