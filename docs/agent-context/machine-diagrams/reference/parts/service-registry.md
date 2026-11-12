## Part: service registry

Choose when the mechanism maps names to addresses. Family: distributed systems; footprint: L.

Props:

None.

Ports:

- `register`: in, E; tokens: `control`
- `lookup`: in, S; tokens: `request`
- `out`: out, W; tokens: `data`, `result`

### service registry.register

Register service s2 and mark it alive. Card: optional; tokens: any; default duration: 0.7 s.

Arguments:

None.

### service registry.resolve

Look up and call the service; expose a stale entry if its service has crashed. Card: optional; tokens: any; default duration: 2.1 s.

Arguments:

None.

### service registry.expire

Remove the registered service entry. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

### service registry.fail

Crash service s2 while leaving its registry entry in place. Card: optional; tokens: any; default duration: 0.4 s.

Arguments:

None.

[Reference index](../../../machine-diagrams-reference.md); [authoring guide](../../../machine-diagrams.md).
