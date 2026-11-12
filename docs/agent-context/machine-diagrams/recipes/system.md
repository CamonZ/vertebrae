# Explain a system flow

Start from a question: what happens to one request? Choose client and worker,
connect the worker's result back to the client, and preserve card identity.
This small hypothetical system needs no source claim or manual placement.

```flow
version: 1
title: One request becomes its result
parts:
  - {id: browser, kind: client, label: browser}
  - {id: service, kind: worker, label: service}
rails:
  - {id: ask, from: browser.request, to: service.in}
  - {id: reply, from: service.out, to: browser.result}
cards:
  - id: requestA
    token: request
    payload: {type: text, value: load account, fields: {account: demo}}
story:
  - id: request
    caption: The browser sends one request; the service starts working.
    steps:
      - {verb: send, part: browser, card: requestA}
      - {verb: stage, part: service, card: requestA, via: ask}
  - id: result
    caption: The same card returns as a result and the browser renders it.
    steps:
      - {verb: finish, part: service, card: requestA, args: {work: 0.4}}
      - {verb: render, part: browser, card: requestA, via: reply}
attachments:
  - {kind: note, text: Illustrative request lifecycle, status: inferred, source: scenario}
```

[Recipe index](../../machine-diagrams-recipes.md).
