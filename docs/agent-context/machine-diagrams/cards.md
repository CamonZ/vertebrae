# Cards and payloads

Tokens are `request`, `data`, `payload`, `result`, `batch`, `copy`, `control`,
`event`, `signal`, `token`; shape conveys their role without color alone.
`control` is hollow; events and signals are dots. Token kind is distinct from
payload type. A stable card ID follows its journey even when its token changes.

`payload` has required `type` (a descriptive string) and `value` (string,
number, boolean or null), optional `eventTime` (number or string), and `fields`
(map of scalar values or null). Example:
`{type: session, value: threadA, fields: {process: 2, resumed: true}}`.
Use attachments for nested JSON comparisons rather than objects in `value`.

Select a part to inspect its evidence and cards; following a card tracks its
ID through the story. `origin` gives its initial part when the first step
must travel a rail from there. A consumed card cannot travel farther.

[Authoring index](../machine-diagrams.md); [story](story.md).
