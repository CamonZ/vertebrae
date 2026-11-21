# Call trees and call diffs

## Inspect the source

1. Use the conversation's checkout. Resolve refs to full commit IDs before
   reading a committed snapshot. For a branch comparison, use the merge base
   when the user asks for the branch's changes. Use `working-tree` for a snapshot
   that includes current edits.
2. Find the actual enclosing function, callback, or component. For a diff,
   read both versions. Group only the direct added, removed, or replaced
   calls under each enclosing function.
3. Cite a repository-relative path and a one-based line for every entry. Use
   the definition for the root and the site that demonstrates each edge. For
   incoming trees, cite the caller's site. Verify the line in the named
   snapshot. Label JSX component references as `render` and asynchronous
   boundaries as `schedule`, `dispatch`, or `register` when the source supports it.
4. Follow another level only if it explains the behavior. Mark an edge
   `ambiguous` when multiple targets are possible, or `dynamic` when runtime
   data selects the target. Use `incomplete` to say what you could not verify.
   Stop at recursion or an unresolved boundary. Keep main paths short.

Write a completed Markdown fence containing one JSON object. Keep diagrams
within 160 nodes or rows, 12 levels, and 64 Ki characters.

## Current call tree

Use `calltree` with a `snapshot` and a single `root`. Set `direction` to `incoming`
for callers or omit it for outgoing calls. Add nested entries in `children`.

```calltree
{"snapshot": "working-tree",
 "root": {"label": "CheckoutPanel", "path": "src/CheckoutPanel.tsx", "line": 20,
   "children": [
     {"label": "OrderSummary", "path": "src/CheckoutPanel.tsx", "line": 31, "relationship": "render"},
     {"label": "submitOrder", "path": "src/CheckoutPanel.tsx", "line": 38}
   ]}}
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
