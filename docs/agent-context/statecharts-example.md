# XState statechart example

Use with [Statechart artifacts](statecharts.md) for the supported subset,
metadata, save/attach commands and typed Markdown links. This is an XState v5
machine configuration, accepted directly by `createMachine(config)`.

`workflow.statechart.json`:

```json
{
  "id": "delivery",
  "description": "Ticket delivery",
  "initial": "Work",
  "states": {
    "Work": {
      "initial": "Implement",
      "on": { "ACCEPT": "#delivery.Done" },
      "states": {
        "Implement": {
          "description": "Make the assigned change.",
          "on": { "READY": "Verify", "RETRY": "Implement" }
        },
        "Verify": {
          "type": "parallel",
          "on": { "CHANGES": "Implement" },
          "onDone": "Ready",
          "states": {
            "Tests": {
              "initial": "Running",
              "states": {
                "Running": { "on": { "PASS": "Passed" } },
                "Passed": { "type": "final" }
              }
            },
            "Review": {
              "initial": "Pending",
              "states": {
                "Pending": { "on": { "APPROVE": "Approved" } },
                "Approved": { "type": "final" }
              }
            }
          }
        },
        "Ready": {}
      }
    },
    "Done": { "type": "final" }
  }
}
```

`workflow.metadata.json`:

```json
{
  "version": 1,
  "content_kind": "statechart",
  "format": "json",
  "origin": "agent",
  "presentation": "rendered",
  "extensions": { "statechart_format": "xstate-v5" }
}
```
