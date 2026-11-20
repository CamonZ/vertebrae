# Semantic diff queries

Each language's registry entry (`src/registry.rs`) joins these files with
its grammar's own tags query.

- `declarations.scm` adds `@definition.<kind>` / `@name` patterns the
  grammar's tags query leaves out.
- `facts.scm` captures what kind of code a change touches. A fact appears
  for a change exactly when the multiset of these captures inside (or
  enclosing) the changed node differs between the old and new side.
  Literals and types are reported only when replaced (`~ 1 → 2`) or when
  they are themselves the changed node, not for every literal in inserted
  code. Each change keeps at most 64 facts, the most telling first, and
  counts the rest.

## Facts capture vocabulary

A pattern has one *primary* capture, the node whose presence is compared,
and optionally *parts* named `<primary>.<part>`:

- `.subject` — the node whose structure identifies the capture and whose
  text names it (defaults to the primary node itself);
- `.receiver` — the expression a method is called on (`recv.name`);
- `.path` — the path a function is reached through (`path::name`).

| Capture | Fact |
|---|---|
| `@call` | the callee's name; classified by the API tables as an effect, `spawn`, `lock` or a trivial call (`ignore`, not reported), else a call |
| `@reference` | a non-call use (`process.env`); a fact only when an API table knows it |
| `@annotation` | an attribute or decorator path; a fact only when an API table knows it |
| `@control.branch`, `@control.match_arm`, `@control.loop`, `@control.early_return` | control flow |
| `@error.propagation`, `@error.unwrap`, `@error.catch`, `@error.throw`, `@error.type` | error handling |
| `@data.literal`, `@data.field`, `@data.type` | data |
| `@api.visibility`, `@api.signature` | API surface |
| `@concurrency.async`, `@concurrency.await`, `@concurrency.spawn`, `@concurrency.lock` | concurrency |
| `@test`, `@test.marker` | test code: changes inside it are marked as such |

Captures starting with `_` serve predicates only. Any other name is a
compile error, so a typo cannot silently disable a category.

Branches, loops and arms take their condition, iterable or pattern as
`.subject`, so changing it reads as a changed condition; keywords used as
`.subject` (`else`, `return`) keep a capture's identity independent of the
code inside it.

`@test.marker` marks an attribute (`#[test]`, `#[cfg(test)]`): it, the
attributes and comments after it, and the item they precede are test code.
