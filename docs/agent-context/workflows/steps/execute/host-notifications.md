# Sending notifications from execute

Purpose: tell the user something happened, with links to the tasks and artifacts involved.
Use this when: a script finishes work worth announcing, records an artifact, or needs attention, and the message should appear in the GUI's Activity panel.

- `vtb::notifications::send(#{ message: message, severity: "success" })`
  publishes `message`, a Markdown string, to the execution's project. Scripts
  never pass a project ID; the notification belongs to the execution's project
  and the daemon's account.
- `severity` is `info` (the default), `success`, `warning` or `error`. Any
  other key in the map is `invalid`.
- The message must not be blank and is at most 4,096 bytes. It is stored and
  shown exactly as composed; Sacrum doesn't parse or check its links.
- It returns the notification: `id`, `project_id`, `message`, `severity`,
  `inserted_at` and `read_at` (`()` while unread). Success means Sacrum stored
  it, not that anyone has seen it.
- Each call creates a new notification, including on a retried attempt.
- `vtb::notifications::escape(text)` backslash-escapes the Markdown
  punctuation that changes inline text (`` \ ` * _ [ ] ( ) < > ! | ~ ``) so
  `text`, such as a task title, renders literally. Escape titles you place
  inside a link label.

Links are ordinary Markdown links to `vtb://<type>/<uuid>`, anywhere in the
sentence:

| Destination | URI |
| --- | --- |
| Task, ticket or epic | `vtb://task/<id>`, `vtb://ticket/<id>`, `vtb://epic/<id>` |
| Artifact | `vtb://artifact/<artifact id>` |

The GUI opens tasks in the entity panel and artifacts on the Artifacts page.
A link to something deleted or outside the project opens nothing.

A notification that fails is `invalid` for bad arguments or a project Sacrum
rejects, `transport` when Sacrum can't be reached (the notification may still
have been stored), and `cancelled` when the step is cancelled.

## Example: announce a published report

```rhai
let report = vtb::artifacts::put(task.id, "report", "All checks passed.");
let message = "Artifact [report](vtb://artifact/" + report.id
    + ") has been added to task [" + vtb::notifications::escape(task.title)
    + "](vtb://task/" + task.id + ").";
let sent = vtb::notifications::send(#{ message: message, severity: "success" });
#{ notification_id: sent.id }
```

## Related
[Writing artifacts](host-artifact-writes.md) · [Limits and cancellation](limits.md) ·
[Context bindings and output](input-output.md)
