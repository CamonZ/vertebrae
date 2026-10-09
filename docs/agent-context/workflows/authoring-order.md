# Authoring order

Purpose: build a workflow graph in the order the backend can validate.
Use this when: creating a new workflow or factory.

## Steps
1. **Workflows**: `vtb workflow add` for each, with a shared `--factory-name`.
2. **Workflow transitions**: `vtb workflow transition add <from> <to> --label <l>`
   for every cross-workflow path, with `--target-step` once steps exist if the entry is not the first step.
3. **Steps**: `vtb step add` per workflow, with `--order`, type, `--harness` for
   inference steps, and config. Author [execute](steps/execute/settings.md) with
   `--step-type execute --script @file.rhai --output-schema <JSON>` and no harness.
   Give every step that feeds a route an output schema (structured_inference
   steps get one from their questions).
4. **Step transitions**: `--transition-to` on each step (see edge rules in [transitions](transitions.md)).
5. **Route configs**: `vtb step update <route> --route-config "$(cat route.json)"` last,
   because the backend validates refs against predecessor schemas and targets against existing edges.

## Why this order
Route validation needs the predecessor's output schema, the step edges and
the workflow transitions to already exist. A route without config is a
draft and is not runnable.

## Gotchas
- Output schemas for `codex` steps must satisfy strict mode (see [output schemas](steps/llm_inference/output-schemas.md)).
- Steps that share a [session](steps/llm_inference/sessions.md) name must run in
  sequence and on the same harness; parallel branches need distinct names.
- Persisting outputs is configured per step (see [artifacts](../artifacts.md)).

## Related
[Concepts](concepts.md) · [Route](steps/route/index.md)
