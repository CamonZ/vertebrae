# Add an inline deeper level

The `drill` data shape is already supported; navigation is subject to the
[viewer availability note](../drill.md). A child has a
complete spec, a separate ID namespace and its own auto-layout. To reference
a saved child instead, replace `drill.spec` with `drill.artifact` containing
its real returned artifact UUID; never use an invented UUID in a delivered spec.

```flow
version: 1
title: Service with a deeper mechanism
parts:
  - id: service
    kind: worker
    drill:
      spec:
        version: 1
        title: Inside the service
        parts:
          - {id: input, kind: source}
          - {id: job, kind: worker}
        rails:
          - {id: enter, from: input.out, to: job.in}
        cards:
          - {id: task, token: request}
        story:
          - steps:
              - {verb: send, part: input, card: task}
              - {verb: stage, part: job, card: task, via: enter}
              - {verb: finish, part: job, card: task}
story:
  - caption: Inspect the service to explain its internal job.
```

[Recipe index](../../machine-diagrams-recipes.md).
