# Output schemas

Purpose: make an llm_inference step return validated JSON.
Use this when: a route, a later step or an artifact needs structured output.

## How it works
- `--output-schema '<json schema>'` is passed to the harness, which enforces
  structured output. The daemon validates the result.
- Later steps see decoded JSON: `previous_output.<field>` in routes and
  handoffs, `steps.<name>.output.<field>` in prompts and state.
- A schema is required for `persistence_options` (see [artifacts](../../../artifacts.md))
  and for any route that reads `previous_output.<path>`.

## Codex strict mode
The `codex` harness rejects schemas that are not strict:
- every property in `properties` must be listed in `required`;
- no type arrays such as `["string","null"]`;
- objects should set `additionalProperties: false`.
Use sentinels instead of optional or null fields: `""` for "no value",
`0` for "no line", `[]` for "none". Say so in the field `description`.

## Doing it
Keep schemas small and flat around what the next decision needs (a verdict
enum, counts, a short summary). Put long prose in one string field.

## Gotchas
- Route refs must exist in this schema; the backend validates them when the route config is saved.
- Changing the schema later can invalidate saved routes and handoffs; update them together.

## Related
[route](../route/index.md) · [Settings](settings.md)
