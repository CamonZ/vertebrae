# Explain Before/After with the same inputs

Question: does a second question launch another process? Change only the
session lifecycle and let its verbs compute the difference. The band counts
actual compile markers; it is not hardcoded to the caption. This hypothetical
change illustrates the supported persistent-session model; attach inspected
source before using it as evidence for a particular PR.

```flow
version: 1
title: Keep an idle session between questions
parts:
  - id: thread
    kind: session
    change: changed
    changeNote: keep the process for follow-up questions
    before: {props: {lifecycle: one-shot}}
    after: {props: {lifecycle: persistent}}
cards:
  - {id: q1, token: request, payload: {type: text, value: Explain this file}}
  - {id: q2, token: request, payload: {type: text, value: And its caller?}}
  - {id: a1, token: result}
  - {id: a2, token: result}
story:
  - id: first
    caption: Both arrangements launch a process for the first question.
    steps:
      - {verb: stage, part: thread, card: q1}
      - {verb: finish, part: thread, card: a1}
  - id: second
    caption:
      before: The follow-up launches a second process.
      after: The follow-up reuses the existing process.
    steps:
      - {verb: stage, part: thread, card: q2}
      - {verb: finish, part: thread, card: a2}
band:
  heading: BETWEEN QUESTIONS
  rows:
    - name: follow-up
      beats: [second]
      note: {before: one-shot, after: persistent}
      chips: {before: [process closed, launch again], after: [process kept, reuse]}
  meter: {label: processes started, marker: [spawn, resume]}
attachments:
  - {kind: note, text: Same questions on both sides; illustrative timing, status: inferred, source: scenario}
```

[Recipe index](../../machine-diagrams-recipes.md).
