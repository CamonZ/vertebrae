# Explain a merged PR

Inspect the actual merged diff and its source anchors first. Identify the
changed path, one concrete input, and the observable result. Choose parts to
explain that mechanism, attach the code/diff supporting each claim, and label
unmeasured scenarios honestly. Do not claim a command or test ran because
the PR added one. When a PR changes behavior, use a shared Before/After spec
as in the next recipe. Save the result to its real ticket when requested.

This example explains merged PR #583 (flow fences and artifacts): `FlowBlock`
uses `useFlowSpec`, which parses and calls `useLaidOutFlow`; `FlowSpecBody`
selects the player, progress or errors. The machine is an analogy for that
rendering pipeline, not a recorded execution. These source paths establish
the claim; they do not establish the illustrative timings or a deployed version.

```flow
version: 1
title: PR 583 — one shared flow viewer
parts:
  - {id: fence, kind: source, label: flow fence or artifact body}
  - id: parser
    kind: transform
    label: parseFlowSpec
    attachments:
      - kind: ref
        path: crates/gui/src/components/shared/useFlowSpec.ts
        symbol: useFlowSpec
        claim: Parses the body and supplies it to useLaidOutFlow
        status: verified
        source: scenario
  - id: viewer
    kind: worker
    label: layout and render
    attachments:
      - kind: ref
        path: crates/gui/src/components/shared/FlowSpecView.tsx
        symbol: FlowSpecBody
        claim: Ready flows mount FlowPlayer; invalid flows list errors
        status: verified
        source: scenario
rails:
  - {id: body, from: fence.out, to: parser.in}
  - {id: parsed, from: parser.out, to: viewer.in}
cards:
  - {id: spec, token: payload, payload: {type: text, value: YAML flow body}}
story:
  - id: parse
    caption: A flow fence or saved body enters the shared parse and compile path.
    steps:
      - {verb: send, part: fence, card: spec}
      - {verb: transform, part: parser, card: spec, via: body, args: {to: FlowSpec}}
  - id: render
    caption: A valid spec is laid out and shown in the player.
    steps:
      - {verb: stage, part: viewer, card: spec, via: parsed}
      - {verb: finish, part: viewer, card: spec}
  - caption: Invalid input instead shows field diagnostics; this story illustrates the valid branch.
```

[Recipe index](../../machine-diagrams-recipes.md).
