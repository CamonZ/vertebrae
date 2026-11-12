## Part: route step

Choose when the mechanism picks the next step by rules. Family: vertebrae workflows; footprint: S.

Props:

- `targets`: `{"type":"string[]","default":["review","docs","plan"]}` — labels of the three transitions (r1, r2, default)

Ports:

- `in`: in, W; tokens: `payload`, `request`, `data` — step output
- `out1`: out, E; tokens: `payload`, `request`, `data` — transition for rule r1
- `out2`: out, E; tokens: `payload`, `request`, `data` — transition for rule r2
- `out3`: out, E; tokens: `payload`, `request`, `data` — default transition

### route step.route

the rules are tried in order and the run leaves by the transition that matches Card: required; tokens: payload, request, data; default duration: 1.9 s.

Arguments:

- `rule`: `{"type":"string","enum":["r1","r2","else"],"default":"r1"}` — which rule matches (else is the default transition)

### route step.decide

the rules are tried and the arm swings, without a run in the step Card: none; tokens: any; default duration: 1.5 s.

Arguments:

- `rule`: `{"type":"string","enum":["r1","r2","else"],"default":"r1"}` — which rule matches (else is the default transition)

### route step.fail

no rule matches and there is no default: the run goes back Card: required; tokens: payload, request, data; default duration: 2.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
