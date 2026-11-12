## Part: alert

Choose when the mechanism gets someone's attention. Family: observability; footprint: S.

Props:

None.

Ports:

- `in`: in, W; tokens: `event`, `signal`, `request`
- `out`: out, E; tokens: `result`, `request` — result (acknowledged)
- `escalate`: out, E; tokens: `request`, `event`; conditional/dashed — escalation

### alert.notify

the event fires the lamp and pages someone Card: optional; tokens: event, signal, request; default duration: 1.1 s.

Arguments:

None.

### alert.acknowledge

someone acknowledges: the lamp stops Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

### alert.escalate

nobody answered: escalate Card: none; tokens: any; default duration: 0.8 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
