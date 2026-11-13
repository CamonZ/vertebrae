# Compare several options on one diagram

Question: how should the api take a burst of jobs? List the options as named
arrangements beside today's machine and write where each part, rail and
step is present; the marks against `current` are computed. A adds a rate
limiter, a queue and a parked-jobs store fed by the queue's dead letters; B
adds only the queue and the store, wired from the queue's `out` as a
journal. The same two jobs run through every option. The illustrative spec
is in `crates/gui/src/components/MachineDiagram/flow/__fixtures__/burstOptions.flow.yaml`.

```flow
version: 1
title: Three ways to take a burst of jobs
arrangements: [current, {name: A, label: "A · limit + queue"}, {name: B, label: "B · queue + journal"}]
parts:
  - {id: client, kind: client}
  - {id: api, kind: worker, label: api}
  - {id: limiter, kind: rate limiter, in: [A], changeNote: sheds jobs over the rate, props: {tokens: 1}}
  - {id: buffer, kind: queue, in: [A, B], changeNote: holds jobs until the api is free}
  - id: parked
    kind: store
    in: [A, B]
    changeNote: keeps the jobs the queue cannot place
    arrangement: {B: {changeNote: journals every job before the api sees it}}
rails:
  - {id: direct, from: client.request, to: api.in, in: [current]}
  - {id: reply, from: api.out, to: client.result}
  - {id: toLimiter, from: client.request, to: limiter.in}
  - {id: limited, from: limiter.out, to: buffer.in}
  - {id: toBuffer, from: client.request, to: buffer.in, in: [B]}
  - {id: queued, from: buffer.out, to: api.in, in: [A]}
  - {id: dead, from: buffer.dead, to: parked.in, in: [A], label: overflow}
  - {id: journal, from: buffer.out, to: parked.in, in: [B], label: every job}
  - {id: replayed, from: parked.out, to: api.in, in: [B]}
cards:
  - {id: j1, token: request, label: job 1, origin: client}
  - {id: j2, token: request, label: job 2, origin: client}
story:
  - caption: {current: Job 1 goes straight to the api., A: Job 1 passes the limiter into the queue., B: Job 1 goes into the queue.}
    steps:
      - {verb: send, part: client, card: j1}
      - {verb: stage, part: api, card: j1, via: direct}
      - {verb: send, part: limiter, card: j1, via: toLimiter}
      - {verb: send, part: buffer, card: j1, via: limited}
      - {verb: send, part: buffer, card: j1, via: toBuffer}
  - caption: {current: The api replies., A: The queue hands job 1 to the api., B: The journal hands job 1 to the api.}
    steps:
      - {verb: drain, part: buffer, card: j1}
      - {verb: stage, part: api, card: j1, via: queued}
      - {verb: read, part: parked, card: j1, via: journal}
      - {verb: stage, part: api, card: j1, via: replayed}
      - {verb: finish, part: api, card: j1}
      - {verb: render, part: client, card: j1, via: reply}
  - id: burst
    caption: {current: Job 2 finds the api busy and fails., A: The limiter sheds job 2., B: Job 2 waits in the queue.}
    steps:
      - {verb: send, part: client, card: j2}
      - {verb: fail, part: api, in: [current]}
      - {verb: fail, part: limiter, card: j2, via: toLimiter}
      - {verb: send, part: buffer, card: j2, via: toBuffer}
band:
  rows:
    - {name: second job, beats: [burst], chips: {current: [busy, fails], A: [over the rate, shed], B: [queued, waits]}}
  meter: {label: hops between parts, marker: arrival}
```

Steps need no `in` when their part or `via` rail already decides: the
limiter's steps run only in A. `fail` on the api runs only today. A
rail defaults to where both its parts are. See [changes](../changes.md).

[Recipe index](../../machine-diagrams-recipes.md).
