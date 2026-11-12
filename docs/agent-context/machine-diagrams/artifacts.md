# Save, attach, read back and reference

Default to a completed `flow` fence. A valid fence offers **Save as artifact**
in conversations tied to a ticket; chats associated with tasks or epics do not
offer that action. Otherwise save with the CLI from the selected project,
within the user's authorized scope. Read [permissions](../permissions.md)
before mutation. Save the body without Markdown fences.

For `explanation.flow.yaml`, write `explanation.metadata.json`:

```json
{
  "version": 1,
  "content_kind": "flow",
  "format": "yaml",
  "presentation": "rendered",
  "extensions": {"flow_format": "flow-v1"}
}
```

Use `format: "json"` for a JSON body. The viewer checks version, content kind,
format and presentation; `flow_format` is the saved marker, not a replacement
for these fields. Use the real existing ticket UUID as `TICKET_ID`; `task` is
the attachment type for tickets, tasks and epics.

```bash
vtb --json artifact add explanation.flow.yaml --body-file explanation.flow.yaml --subject-type task --subject-id "$TICKET_ID" --logical-name machine-explanation --metadata-file explanation.metadata.json
vtb --json artifact lookup machine-explanation --subject-type task --subject-id "$TICKET_ID"
vtb --json artifact show "$ARTIFACT_ID"
```

Set `ARTIFACT_ID` to the exact returned `artifact_id` (also `artifact.id`)
before `show`. Add and attach are one operation; there is no separate attach
command. For a PR, attach to its real ticket and reference the returned
artifact in the PR; PR is not an artifact subject type. Emit an ordinary
Markdown link using the actual ID:
`[Explanation](vtb://artifact/<actual-returned-id>)`.

Rendered flow artifacts play in previews and chat embeds. Saving does not
start a TaskRun. Missing or malformed artifacts keep their link and display
their failure instead of inventing a diagram.

[Authoring index](../machine-diagrams.md).
