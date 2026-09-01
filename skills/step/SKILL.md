---
name: step
description: Manage workflow steps
---

# /step

Manage first-class workflow steps. Steps define the stages a task moves through within a workflow.

> **Short IDs:** Step, workflow, and transition-target arguments accept either
> a full UUID or an 8-character short ID. Resolution works uniformly across
> tasks, workflows, and steps.

## Subcommands

| Command | Description |
|---------|-------------|
| `step add` | Create a new step for a workflow |
| `step list` | List all steps for a workflow |
| `step show` | Show step details |
| `step update` | Update step properties |
| `step delete` | Delete a step |

---

## step add

Create a new step for a workflow.

```bash
# Basic step
vtb step add "Review" -w <workflow-id>

# With goal and model
vtb step add "Coding" -w <workflow-id> --goal "Implement the feature" --model sonnet

# Codex/OpenAI with per-step reasoning effort
vtb step add "Coding" -w <workflow-id> \
  --provider openai \
  --model gpt-5.5 \
  --reasoning-effort high

# Codex with serving speed, personality, and output detail
vtb step add "Codex review" -w <workflow-id> \
  --provider openai \
  --model gpt-5.5 \
  --speed-tier fast \
  --personality pragmatic \
  --verbosity high

# Codex/OpenAI with a configured upstream provider
vtb step add "Coding" -w <workflow-id> \
  --provider openai \
  --codex-model-provider openrouter \
  --model deepseek/deepseek-v4-flash

# With prompt and full agent config JSON
vtb step add "Coding" -w <workflow-id> \
  --prompt "Implement the task described in {{task.id}}" \
  --agent-config '{"model":"opus","max_budget_usd":5.0}'

# With agents and skills
vtb step add "Testing" -w <workflow-id> \
  --agent .claude/agents/test-runner.md \
  --skill run-tests \
  --skill check-coverage

# With transitions and a finish step
vtb step add "Approved" -w <workflow-id> --step-type finish
vtb step add "Needs Work" -w <workflow-id> --transition-to <step-id>

# With step type and structured output schema
vtb step add "Evaluate" -w <workflow-id> \
  --step-type evaluate \
  --output-schema '{"type":"object","required":["passed"],"properties":{"passed":{"type":"boolean"}}}'

# Create a deterministic route draft, then configure it after graph targets exist
vtb step add "Router" -w <workflow-id> --step-type route
vtb step update <step-id> --route-config '<route-config-json>'

# Persist validated structured output as a task artifact (Sacrum-owned)
vtb step add "Evaluate" -w <workflow-id> \
  --step-type evaluate \
  --output-schema '{"type":"object","required":["passed"]}' \
  --persistence-options '{"artifact":{"logical_name":"step_result"}}'

# Machine-readable creation result
vtb --json step add "Review" -w <workflow-id>
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--json` | | Global flag; output machine-readable JSON |
| `--workflow` | `-w` | Workflow ID (required) |
| `--id` | | Optional step ID; auto-generated if omitted |
| `--goal` | `-g` | Goal describing what this step accomplishes |
| `--agent` | `-a` | Path to agent file (repeatable) |
| `--skill` | `-s` | Skill name (repeatable) |
| `--prompt` | | Prompt sent to the agent when executing this step |
| `--agent-config` | | Full agent config as a JSON string |
| `--model` | `-m` | Model to use |
| `--provider` | | Built-in provider: `anthropic`/`claude` or `openai`/`codex`; alias `--model-provider` |
| `--codex-model-provider` | | Codex upstream provider from `~/.codex/config.toml`; alias `--codex-provider` |
| `--reasoning-effort` | | OpenAI/Codex-only effort: `low`, `medium`, `high`, or `xhigh` |
| `--speed-tier` | | Provider serving speed preference: `default` or `fast` |
| `--personality` | | Provider style identifier; Codex accepts `none`, `friendly`, or `pragmatic` when supported by the selected model |
| `--verbosity` | | Output detail level: `low`, `medium`, or `high`; alias `--output-verbosity`; currently valid with OpenAI/Codex |
| `--step-type` | | Step type: `execute`, `evaluate`, `route`, `wait_children`, `human_input`, `stop`, or `finish` (default: `execute`) |
| `--output-schema` | | JSON Schema describing expected structured output |
| `--route-config` | | Opaque deterministic route configuration as a JSON string; only valid for `route` steps |
| `--persistence-options` | | Sacrum-owned JSON configuration for persisting structured output as a task artifact |
| `--order` | `-o` | Step order (default: 0) |
| `--transition-to` | `-t` | Steps this can transition to (repeatable) |

The required positional argument is `<name>`. `--workflow` and
`--transition-to` accept full UUIDs or 8-character short IDs. `--json` returns a
creation envelope with `command`, `status`, `step_id`, and `workflow_id`.

`--reasoning-effort` is only valid with the OpenAI/Codex provider. Supported
values are `low`, `medium`, `high`, and `xhigh`; Claude/Anthropic steps reject
the field.

`--speed-tier` accepts `default` and `fast`. `--personality` is normalized to a
lowercase provider style identifier. Codex accepts `none`, `friendly`, and
`pragmatic`, subject to the selected model's live capability; Claude forwards
the value as its `outputStyle`. `--verbosity` accepts `low`, `medium`, and
`high`, with `--output-verbosity` as an alias, and is currently only valid for
OpenAI/Codex steps. The three settings are independent of reasoning effort.

`--persistence-options` accepts Sacrum's persistence configuration, currently
`{"artifact":{"logical_name":"<name>"}}`. It requires an output schema;
Sacrum validates the logical name and owns the resulting task artifact.

`--route-config` accepts nullable, opaque deterministic route JSON and is only
valid for `route` steps. A route may be created without it as a non-runnable
draft; configure it after the workflow graph and predecessor contracts exist.
Route authoring rejects `--prompt` and `--output-schema`; neither is a routing
mechanism.

---

## step list

List all steps for a workflow.

```bash
vtb step list <workflow-id>

# Machine-readable list of raw step objects
vtb --json step list <workflow-id>
```

Output:
```
Steps for workflow '<workflow-id>':
1. coding (id: a1b2c3d4, type: execute, model: sonnet)
2. testing (id: e5f6a7b8, type: evaluate, model: haiku)
3. approved (id: c9d0e1f2, type: finish, model: default)
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--json` | | Global flag; output machine-readable JSON |
| `--help` | `-h` | Print help |

The required positional argument is `<workflow>`, the workflow ID whose steps
should be listed. It accepts a full UUID or an 8-character short ID. There are
no command-specific flags or aliases for `step list`.

When no steps exist, human-readable output is:

```text
No steps found for workflow '<workflow-id>'
```

`--json` returns the raw array of `Step` objects with fields such as `id`,
`name`, `workflow_id`, `order`, `step_type`, `agent_config`,
`output_schema`, `route_config`, `persistence_options`, `transitions_to`, and
timestamps. It does not wrap the result in an `output` field.

---

## step show

Show detailed step information.

```bash
vtb step show <step-id>

# Machine-readable raw step object
vtb --json step show <step-id>
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--json` | | Output machine-readable JSON instead of human-readable text |
| `--help` | `-h` | Print help |

The required positional argument is `<id>`, the step ID to show. It accepts a
full UUID or an 8-character hex short ID and is resolved case-insensitively.
There are no command aliases, defaults, or value enums for `step show`.

Human-readable output is a flat detail view with the step ID and name, workflow
ID, order, step type, goal, agents, skills, model, output schema, route config,
transitions, and persistence configuration, and created/updated timestamps.
Missing optional fields are shown as `(none)`, and missing timestamps are shown
as `-`.

`--json` returns the raw `Step` object with fields such as `id`, `name`,
`workflow_id`, `order`, `goal`, `prompt`, `agents`, `skills`, `step_type`,
`agent_config`, `output_schema`, `route_config`, `persistence_options`,
`transitions_to`, and timestamps.
It does not wrap the result in an `output` field.

`route_config` is nullable opaque JSON. An empty object is distinct from `null`;
the CLI preserves the value without interpreting or normalizing the route AST.

If a full UUID reaches `step show` but no matching step exists, the command
fails with `Step not found: <id>`. If an 8-character hex short ID cannot be
resolved, the shared ID resolver reports `step with prefix '<id>' not found`.

---

## step update

Update step properties.

```bash
# Update goal
vtb step update <step-id> --goal "New goal description"

# Change model
vtb step update <step-id> --model opus

# Configure provider model settings
vtb step update <step-id> \
  --provider openai \
  --model gpt-5.5 \
  --speed-tier fast \
  --personality friendly \
  --verbosity low

# Clear model settings independently
vtb step update <step-id> \
  --clear-speed-tier \
  --clear-personality \
  --clear-verbosity

# Move a step to Codex and set reasoning effort
vtb step update <step-id> --provider openai --model gpt-5.5 --reasoning-effort high

# Use provider aliases
vtb step update <step-id> --model-provider openai --codex-provider openrouter

# Replace agents list (replaces entire list, not additive)
vtb step update <step-id> --agent .claude/agents/reviewer.md

# Replace skills list (replaces entire list, not additive)
vtb step update <step-id> --skill review --skill simplify

# Replace prompt, step type, and output schema on an ordinary execution step
vtb step update <step-id> --prompt "Review task {{task.id}}"
vtb step update <step-id> --step-type evaluate
vtb step update <step-id> --output-schema '{"type":"object"}'

# Clear a retained prompt
vtb step update <step-id> --clear-prompt

# Configure or clear a deterministic route
vtb step update <step-id> --route-config '<route-config-json>'
vtb step update <step-id> --clear-route-config

# Clear all agents
vtb step update <step-id> --clear-agents

# Clear all skills
vtb step update <step-id> --clear-skills

# Clear output schema
vtb step update <step-id> --clear-output-schema

# Configure or clear structured-output artifact persistence
vtb step update <step-id> \
  --persistence-options '{"artifact":{"logical_name":"step_result"}}'
vtb step update <step-id> --clear-persistence-options

# Clear all transitions
vtb step update <step-id> --clear-transitions

# Change order
vtb step update <step-id> --order 1

# Change terminality by setting the finish step type
vtb step update <step-id> --step-type finish

# Machine-readable update result
vtb --json step update <step-id> --goal "New goal"
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--json` | | Global flag; output machine-readable JSON |
| `--name` | | New step name |
| `--goal` | `-g` | New goal |
| `--agent` | `-a` | Replace agents list; repeatable |
| `--clear-agents` | | Clear all agents |
| `--skill` | `-s` | Replace skills list; repeatable |
| `--clear-skills` | | Clear all skills |
| `--prompt` | | New prompt |
| `--clear-prompt` | | Explicitly clear a retained prompt |
| `--agent-config` | | Full agent config as a JSON string |
| `--model` | `-m` | Agent model shortcut |
| `--provider` | | Built-in provider: `anthropic`/`claude` or `openai`/`codex`; alias `--model-provider` |
| `--codex-model-provider` | | Codex upstream provider from `~/.codex/config.toml`; alias `--codex-provider`; only valid when the resulting provider is OpenAI/Codex |
| `--reasoning-effort` | | OpenAI/Codex-only effort: `low`, `medium`, `high`, or `xhigh`; only valid when the resulting provider is OpenAI/Codex |
| `--step-type` | | Step type: `execute`, `evaluate`, `route`, `wait_children`, `human_input`, `stop`, or `finish` |
| `--output-schema` | | New output schema as a JSON string |
| `--clear-output-schema` | | Clear the output schema |
| `--route-config` | | Replace the opaque deterministic route configuration |
| `--clear-route-config` | | Clear the route configuration, leaving a route draft |
| `--persistence-options` | | Replace Sacrum's persistence configuration with JSON |
| `--clear-persistence-options` | | Clear the persistence configuration (send `null`) |
| `--order` | `-o` | New 0-indexed step order |
| `--transition-to` | `-t` | Replace transitions list; repeatable |
| `--clear-transitions` | | Clear all transitions |
| `--speed-tier` | | New provider serving speed preference: `default` or `fast` |
| `--personality` | | New provider style identifier; Codex accepts `none`, `friendly`, or `pragmatic` when supported by the selected model |
| `--verbosity` | | New output detail level: `low`, `medium`, or `high`; alias `--output-verbosity`; currently valid with OpenAI/Codex |
| `--clear-speed-tier` | | Remove the stored speed preference |
| `--clear-personality` | | Remove the stored personality |
| `--clear-verbosity` | | Remove the stored output verbosity |

The required positional argument is `<id>`, the step ID to update. It accepts a
full UUID or an 8-character short ID and resolves case-insensitively.

`--agent`, `--skill`, and `--transition-to` replace their entire existing lists.
Use the matching `--clear-*` flag to persist an empty list. `--agent-config`
can replace the full config, and the shortcut flags (`--provider`, `--model`,
`--codex-model-provider`, `--reasoning-effort`, `--speed-tier`,
`--personality`, and `--verbosity`) overlay individual fields. The
equivalent JSON fields are `provider`, `model`, `codex_model_provider`,
`reasoning_effort`, `speed_tier`, `personality`, and `verbosity`:

```bash
vtb step update <step-id> \
  --agent-config '{"provider":"openai","model":"gpt-5.5","speed_tier":"fast","personality":"pragmatic","verbosity":"high"}'
```

`--json` returns an operation envelope with `command`, `status`, and `step_id`.
Invalid `--agent-config`, `--output-schema`, `--persistence-options`, or
`--route-config` JSON fails before persistence. Use
`--clear-persistence-options` to remove the
nullable field; setting `{}` is accepted by Sacrum as an empty configuration,
but it does not create an artifact and is not equivalent to clearing the field.
For a resulting `route` step, `--prompt` and `--output-schema` are rejected;
an existing prompt can only be inspected or explicitly removed with
`--clear-prompt`. Route configuration is semantically validated by Sacrum, and
nested diagnostics retain
their `route_config` field paths. Clearing route configuration leaves an
unconfigured, non-runnable route draft.
Provider/model mismatches, Codex upstream provider usage when the resulting
provider is Anthropic, Anthropic reasoning effort, and Anthropic verbosity are
rejected by the CLI before the step is updated. Codex personality values outside
`none`, `friendly`, and `pragmatic` are also rejected.

---

## step delete

Delete a step.

```bash
vtb step delete <step-id>

# Accepted for compatibility; deletion does not prompt either way
vtb step delete <step-id> --force

# Machine-readable deletion result
vtb --json step delete <step-id>
```

### Options

| Flag | Short | Description |
|------|-------|-------------|
| `--json` | | Global flag; output machine-readable JSON |
| `--force` | `-f` | Accepted for compatibility; step deletion does not prompt for confirmation |
| `--help` | `-h` | Print help |

The required positional argument is `<id>`, the step ID to delete. It accepts a
full UUID or an 8-character short ID and resolves case-insensitively.

Human-readable success output is:

```text
Deleted step: <step-id>
```

`--json` returns an operation envelope with `command`, `status`, and `step_id`.
`step_id` is lowercased in JSON output.

If a full UUID reaches `step delete` but no matching step exists, the command
fails with `Step not found: <id>`. If an 8-character hex short ID cannot be
resolved, the shared ID resolver reports `step with prefix '<id>' not found`.

---

## Step Concepts

### Deterministic route configuration

`route_config` is nullable, opaque JSON owned semantically by Sacrum. Vertebrae
only validates JSON syntax and argument consistency, transports the value, and
renders backend diagnostics; it does not interpret the route AST or generate a
prompt, output schema, or client-side evaluator.

The V1 envelope has this general shape:

```json
{
  "version": 1,
  "match_policy": "exactly_one",
  "rules": [
    {
      "id": "approved-result",
      "when": {
        "ref": "previous_output.route.result",
        "op": "eq",
        "value": "approved"
      },
      "transition": {
        "type": "intra_workflow",
        "step_id": "<target-step-id>"
      }
    }
  ],
  "default": {
    "transition": {
      "type": "intra_workflow",
      "step_id": "<default-step-id>"
    },
    "handoff": {}
  }
}
```

Use persisted graph targets and let Sacrum validate the complete graph. A route
can be created without configuration as a draft; `--clear-route-config` returns
a configured route to that state. Retained route prompts are readable and can
be cleared with `--clear-prompt`, but `--prompt` is never a route authoring
mechanism. New route authoring cannot set an `output_schema`; when converting a
structured step to `route`, clear it in the same update with
`--clear-output-schema`. Legacy route rows may still expose their retained
output schema for inspection, but Vertebrae does not write or interpret that
old routing contract. Ordinary `execute` and `evaluate` steps retain their
normal prompt and `output_schema` behavior.

### Persistence Options

Sacrum's orchestrator can persist validated structured output as a JSON artifact
attached to the current task:

```json
{"artifact":{"logical_name":"step_result"}}
```

The logical name must be nonblank and at most 255 characters. Artifact
persistence requires `--output-schema`; repeated writes upsert the task artifact
by logical name. The daemon only produces and validates output; it does not
interpret this setting or create artifacts. `finish` and `stop` persistence is
rejected by Sacrum.

### Order
Steps are ordered by their `order` field. Lower values execute first.

### Finish Steps
Steps with `--step-type finish` represent completion states. Sacrum completes
the task and updates dependent-task readiness when a task reaches a finish step.

### Transitions
By default, steps can transition to any other step. Use `--transition-to` to restrict valid transitions.

### Agents
Steps can have associated agent files that provide prompts and configuration for AI-assisted execution.

### Skills
Steps can reference skills (slash commands) available during that step.
