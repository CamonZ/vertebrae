# Semantic diff queries

Each language's registry entry (`src/registry.rs`) joins these files with
its grammar's own tags query (Elixir's `declarations.scm` replaces it).

- `declarations.scm` adds `@definition.<kind>` / `@name` patterns the
  grammar's tags query leaves out. Optional captures in the same match:
  `@keyword`, the token labelling the declaration where the grammar has
  no keyword token (Elixir's `def`, a call target); `@parameters`, a
  callable's parameter list, for its arity where the language counts it;
  `@body`, where a callable's signature ends, where the grammar has no
  `body` field (a `@body` match needs no `@name`).
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
- `.path` — the path a function is reached through (`path::name`);
- `.arguments` — a call's arguments, for its arity (code intelligence,
  where the language identifies callables by arity);
- `.piped` — a value piped into the call (`x |> f()`), its first
  argument.

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
| `@ignore` | not a call site (a function head, a module attribute): `@call` and `@reference` captures inside it are dropped |

Captures starting with `_` serve predicates only. Any other name is a
compile error, so a typo cannot silently disable a category.

Branches, loops and arms take their condition, iterable or pattern as
`.subject`, so changing it reads as a changed condition; keywords used as
`.subject` (`else`, `return`) keep a capture's identity independent of the
code inside it.

`@test.marker` marks an attribute (`#[test]`, `#[cfg(test)]`): it, the
attributes and comments after it, and the item they precede are test code.
A language may also name test files (`Profile::test_files`, Elixir's
`test/…_test.exs`): every change in one is test code.

## Bindings capture vocabulary

Code intelligence (`src/intelligence`) reads `imports.scm` and
`locals.scm`, with the definitions of the declarations query and the
`@call` captures of the facts query. Each match identifies a binding or a
binding pattern. The language's registry entry (`intelligence::rules::Rules`)
defines reach, module layout, exports, receivers, and local visibility.

| Capture | Meaning |
|---|---|
| `@import.source` | the module the names come from (`'./m'`, `.pkg.m`) |
| `@import.name` | an imported name, relative to the source when there is one; without one, a whole path whose last segment it binds (Rust `use a::b`, prefixed by enclosing `a::{…}` lists) |
| `@import.alias` | the local name, when it is not the imported one |
| `@import.module` | a local name for the source module, or (without a source) a module path whose first segment it binds (Python `import a.b`) |
| `@import.default` | a local name for the source's default export |
| `@import.glob` | a path (or the source) all of whose names are imported |
| `@import.except` | a name the glob import in the same match leaves out (Elixir's `except:`) |
| `@local` | a parameter, `let`, assignment or loop binding. A call bound only to a local is unresolved. Other candidates are kept as ambiguous unless the language excludes shadowed items. |
| `@local.rust_pattern` | a Rust binding pattern whose introduced names are extracted from its pattern positions. Visible Rust locals exclude shadowed items as unqualified call targets. |

An imported or excluded name written as a keyword key (`save: 1`) reads
without its colon, and the integer beside it is its arity.

Re-exports (`pub use`, `export * from`) are not followed: a name reached
only through one resolves by name match, or not at all.
