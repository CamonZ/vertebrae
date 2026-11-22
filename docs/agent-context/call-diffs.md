# Call trees and call diffs

## Inspect the source

1. Use the conversation's checkout and resolve refs to full commit IDs. Use
   the merge base for a branch's changes and `working-tree` for current edits.
2. Find the actual enclosing function, callback, or component. For a diff,
   read both versions. Group only the direct added, removed, or replaced
   calls under each enclosing function.
3. Cite a repository-relative path and a one-based line for every entry. Use
   the definition for the root and the site that demonstrates each edge. For
   incoming trees, cite the caller's site. Verify the line in the named
   snapshot. Label JSX component references as `render` and asynchronous
   boundaries as `schedule`, `dispatch`, or `register` when supported.
4. Keep paths short. Stop at recursion or an unresolved boundary.

Write a completed Markdown fence containing one JSON object of at most 65,536
characters. A call tree can have up to 160 nodes and 12 levels. Count the root
as one node at level 1 and count every child, including those on collapsed
branches. If a path would reach level 13, split it at a boundary such as a
Tauri command and use that boundary as the root of a second diagram. If you
omit branches to fit, describe what was omitted in a top-level `incomplete`
string. A call diff can have up to 160 rows, counting enclosing functions and
their child rows.

The allowed `certainty` values are `verified`, `ambiguous` (multiple targets
are possible), and `dynamic` (runtime data selects the target). Omit an edge
when you lack source evidence for it, such as an unverified component
re-render. Describe the gap in the diagram's top-level `incomplete` string.

## Current call tree

Use `calltree` with a `snapshot` and a single `root`. Set `direction` to `incoming`
for callers or omit it for outgoing calls. Add nested entries in `children`.

```calltree
{"snapshot": "working-tree",
 "root": {"label": "CheckoutPanel", "path": "src/CheckoutPanel.tsx", "line": 20,
   "children": [
     {"label": "OrderSummary", "path": "src/CheckoutPanel.tsx", "line": 31, "relationship": "render"},
     {"label": "submitOrder", "path": "src/CheckoutPanel.tsx", "line": 38}
   ]},
 "incomplete": "Omitted a cart re-render because its trigger could not be verified."}
```

Replace the example locations with verified `label`, `path`, and `line` values.
The defaults are `relationship: "call"` and `certainty: "verified"`. Branches
expand on demand. Clicking a name opens the cited source in the file viewer.
Working-tree citations use the chat's recorded file-reference behavior.

## Call diff

Use `calldiff` with a full commit ID for `base` and a full commit ID or
`working-tree` for `target`. Each top-level row names the enclosing function
on each side where it exists, with a citation to its definition. A callback
can use a descriptive qualified name such as `CheckoutPanel.onSubmit`.

Put its direct call changes in `children`. Use callee names as labels. Do
not include the call expression, assignment, surrounding code, unchanged
calls, or nested implementations. Give each child an `old` entry for a
removal, a `new` entry for an addition, or both for a replacement. Use source
coordinates for navigation. The diagram shows names and changes only.

```calldiff
{"base": "1111111111111111111111111111111111111111", "target": "working-tree",
 "rows": [
   {"old": {"label": "submitOrder", "path": "src/orders.ts", "line": 10},
    "new": {"label": "submitOrder", "path": "src/orders.ts", "line": 10},
    "children": [
      {"old": {"label": "validate", "path": "src/orders.ts", "line": 12},
       "new": {"label": "validateAndPrice", "path": "src/orders.ts", "line": 14}}
    ]}
 ]}
```

Replace the example commit and verify each side's line numbers separately.

Use a [machine diagram](machine-diagrams.md) when the point is a runtime
sequence, state transition, or interaction among components.
