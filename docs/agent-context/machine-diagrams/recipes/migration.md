# Tell a migration in phases

Question: how does chat move from a process per question to one session per
thread? List the phases in order and start each at the beat where it begins.
Write presence with `in`: the per-question process is in `today` and
`flagged`, the thread session from `flagged` on. Marks are against the
previous phase: the session is + only in `flagged`, the per-question process
ghosts out − in `every`. A fuller spec is the GUI fixture
`flow/__fixtures__/sessionMigration.flow.yaml`.

```flow
version: 1
title: "Chat: from a process per question to one session per thread"
phases:
  - {name: today, label: "Today · process per question"}
  - {name: flagged, label: "1 · flagged threads"}
  - {name: every, label: "2 · every thread"}
  - {name: target, label: "Target · idle close, resume"}
parts:
  - {id: client, kind: client, label: chat pane}
  - id: router
    kind: router
    label: turn router
    arrangement:
      flagged: {changeNote: sends flagged threads to their session}
      every: {changeNote: sends every thread to its session}
      target: {changeNote: sends every thread to its session}
  - {id: perQuestion, kind: session, label: per-question process, in: [today, flagged], changeNote: "retired: every thread has a session", props: {lifecycle: one-shot}}
  - id: thread
    kind: session
    label: thread session
    in: [flagged, every, target]
    changeNote: one process kept for the thread
    arrangement: {target: {changeNote: "closes when idle, resumes from its id"}}
  - {id: stream, kind: worker, label: answer stream}
rails:
  - {id: ask, from: client.request, to: router.in}
  - {id: spawnEach, from: router.r1, to: perQuestion.turn, label: new process}
  - {id: toThread, from: router.r2, to: thread.turn, label: thread id}
  - {id: answerOnce, from: perQuestion.out, to: stream.in}
  - {id: answerThread, from: thread.out, to: stream.in}
  - {id: reply, from: stream.out, to: client.result}
cards:
  - {id: q1, token: request, label: question 1, origin: client}
  - {id: q2, token: request, label: question 2, origin: client}
story:
  - caption: Today every question starts its own process.
    steps:
      - {verb: send, part: client, card: q1}
      - {verb: decide, part: router, card: q1, via: ask, args: {to: r1}}
      - {verb: stage, part: perQuestion, card: q1, via: spawnEach}
      - {verb: finish, part: perQuestion, card: q1}
      - {verb: stage, part: stream, card: q1, via: answerOnce}
      - {verb: finish, part: stream, card: q1}
      - {verb: render, part: client, card: q1, via: reply}
  - phase: flagged
    caption: "Phase 1: a flagged thread goes to a session that outlives the question."
    steps:
      - {verb: send, part: client, card: q2}
      - {verb: decide, part: router, card: q2, via: ask, args: {to: r2}}
      - {verb: stage, part: thread, card: q2, via: toThread}
      - {verb: finish, part: thread, card: q2}
      - {verb: stage, part: stream, card: q2, via: answerThread}
      - {verb: finish, part: stream, card: q2}
      - {verb: render, part: client, card: q2, via: reply}
  - phase: every
    caption: "Phase 2: every thread has its session; the per-question path is retired."
  - phase: target
    caption: "Target: an idle session closes, keeping its resume id."
    steps:
      - {verb: close, part: thread}
```

Start each phase at the beat that shows its first difference. Cards carry
across phases: the session closed in `target` is the one `flagged` started.
Repeat an override (the router's in `target`) to keep a part unchanged; one
that differs from the previous phase's marks it changed. Layout is shared by
every phase. See [phases](../phases.md).

[Recipe index](../../machine-diagrams-recipes.md).
