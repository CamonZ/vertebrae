# Diagnostics and maintenance

Parsing accepts JSON (body starts with `{`) or YAML with JSON scalar types.
Errors contain `path`, `message`, and sometimes `expected` alternatives:
`story[2].steps[0].verb` identifies a field; unknown names may suggest a
spelling. Fix the named field, then validate again. JSON Schema alone cannot
check port/card references or all compiler behavior; `vtb flow validate`
runs the viewer's parse → validate → compile path in an embedded engine.

`vtb flow validate` embeds `crates/cli/assets/flow-validator.js`, generated
from `flow/validatorEntry.ts`. After changing the flow sources, rebuild it
with `npm run build:flow-validator` from `crates/gui`;
`flowValidator.bundle.test.ts` fails while the committed bundle is stale.

When adding a part, verb, prop, argument or attachment, update its reference
page and selection/semantics prose, and check the recipes still pass
`vtb flow validate`. Agent-context embedding tests enforce resolvable links,
reachability and at most 80 lines per document:

```bash
cargo test --locked -p vertebrae-agent-context
```

The shipped sources are `flow/spec.ts`, `flow/registry.ts`, `flow/parts/`,
`flow/drawings.ts`, `flow/attachments.ts`, `flow/errors.ts` and
`flow/jsonSchema.ts` under `crates/gui/src/components/MachineDiagram/`.
Check `flow/layout.ts`, `flow/band.ts`, `shared/FlowBlock.tsx` and
`shared/FlowSpecView.tsx` for viewer behavior. Shared components live under
`crates/gui/src/components/`, alongside MachineDiagram.

[Authoring index](../machine-diagrams.md); [reference](../machine-diagrams-reference.md).
