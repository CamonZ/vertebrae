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

## Bindings capture vocabulary

Code intelligence (`src/intelligence`) reads `imports.scm` and
`locals.scm`, with the definitions of the declarations query and the
`@call` captures of the facts query. Each match is one binding; the other
resolution rules (reach, module layout, exports, `self` receivers, whether
inline modules are scopes, whether nested functions see enclosing locals)
are data in the language's registry entry (`intelligence::rules::Rules`).

| Capture | Meaning |
|---|---|
| `@import.source` | the module the names come from (`'./m'`, `.pkg.m`) |
| `@import.name` | an imported name, relative to the source when there is one; without one, a whole path whose last segment it binds (Rust `use a::b`, prefixed by enclosing `a::{…}` lists) |
| `@import.alias` | the local name, when it is not the imported one |
| `@import.module` | a local name for the source module, or (without a source) a module path whose first segment it binds (Python `import a.b`) |
| `@import.default` | a local name for the source's default export |
| `@import.glob` | a path (or the source) all of whose names are imported |
| `@local` | a parameter, `let`, assignment or loop binding: it shadows definitions of its name in its function without being one, so a call bound to it and to a definition is ambiguous, and one bound only to it is unresolved |

Re-exports (`pub use`, `export * from`) are not followed: a name reached
only through one resolves by name match, or not at all.
