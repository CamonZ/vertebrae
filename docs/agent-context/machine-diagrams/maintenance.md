# Diagnostics and maintenance

Parsing accepts JSON (body starts with `{`) or YAML with JSON scalar types.
Errors contain `path`, `message`, and sometimes `expected` alternatives:
`story[2].steps[0].verb` identifies a field; unknown names may suggest a
spelling. Fix the named field, then validate again. JSON Schema alone cannot
check port/card references or all compiler behavior. Use the same parse →
validate → layout/compile → viewer path as chat.

When adding a part, verb, prop, argument or attachment, update its reference
page and selection/semantics prose, then keep recipes passing. From `crates/gui`:

```bash
npm test -- src/components/MachineDiagram/flow/authoringDocs.test.tsx
```

The coverage test enumerates `flowSpecJsonSchema(registry)` and registered
definitions, and fails when a kind, per-kind verb or attachment entry is
missing. Field contracts and semantic prose also require review. The recipe
tests render every published `flow` block through `FlowSpecView`. These prove
supported examples and coverage, not model instruction-following reliability
or measured behavior. Agent-context embedding tests also enforce resolvable
links, reachability and at most 80 lines per document:

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
