# Selective agent guideline consumption

Guideline artifacts are project-scoped inputs, not implicit capabilities of a
session. Artifact bodies are authoritative. Catalog tags are candidate
selectors and do not prove delivery, applicability, or compliance.

## Selection

Use supplied content or supplied logical names and IDs first. Otherwise inspect
the active project and lookup only the needed catalog:

```text
vtb --json artifact lookup <logical-name> --subject-type project --subject-id <project-id>
```

Confirm the exact syntax with `vtb artifact lookup --help` in the checkout.
Parse the catalog JSON, then select one primary guide by changed
responsibility and `applies_when`/`scope_boundary`. Add independently applicable
guides only as needed; never fetch the entire library. Mixed Rust/Tauri/
TypeScript work may select one guide per changed responsibility, and selection
must be revisited if the scope changes.

A missing catalog entry is a coverage gap. Do not silently substitute a guide
from another project or namespace. If a supplied hash does not match the
resolved body, it is not the pinned version; report the mismatch and ask only
if correctness depends on it. The observed catalogs publish
`automatic_rendering_implemented=false`; their existence does not mean
automatic injection or rendering is implemented.

## Provenance and rules

Record logical name, resolved artifact ID, content hash (or “unavailable”),
selected rule IDs, checks performed, and exception rationale. Hash exact body
bytes, including newlines, rather than a rendered representation. Orchestration
should persist selected snapshots/hashes where its interface supports that;
this document does not claim that persistence exists today.

Separate required contracts from defaults. A default may have a concrete,
task-local alternative; changing a required contract needs explicit
authorization. Rust enforcement metadata is `explicit_policy`,
`default_clippy`, `deferred_candidate`, or `none_identified`; current checks
cover portions of eight rules and are not blanket guideline compliance. See
`docs/rust-guideline-enforcement.md` for the maintained enforcement details.

## Worked illustrations

For a Rust cancellation/lifecycle change, select the catalog guide whose scope
covers cancellation ownership and lifecycle cleanup, then any separately
applicable replay guide. Verify focused tests and record the rule IDs; do not
infer coverage from a green Clippy run.

For a TypeScript project-isolated async-state change, select the guide whose
scope covers project identity and async state ownership, then verify the
focused GUI checks. These are selection illustrations, not runnable tasks or
definitions of project APIs.

## Minimal evidence

```text
logical name: rust-best-practices/catalog
artifact ID: <resolved project-scoped ID>
content hash: <hash, or unavailable>
selected rules: R-...; R-...
exception: <task-local alternative and rationale, or none>
checks: <exact commands and observed results>
residual obligations: <unrun checks or review limits>
```

If scope expands, repeat selection and provenance. Never claim that a tag,
catalog presence, or passing linter establishes full compliance.
