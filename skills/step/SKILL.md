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

# With transitions and final flag
vtb step add "Approved" -w <workflow-id> --final
vtb step add "Needs Work" -w <workflow-id> --transition-to <step-id>

# With step type and structured output schema
vtb step add "Evaluate" -w <workflow-id> \
  --step-type evaluate \
  --output-schema '{"type":"object","required":["passed"],"properties":{"passed":{"type":"boolean"}}}'

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
| `--step-type` | | Step type: `execute`, `evaluate`, `route`, `wait_children`, or `human_input` (default: `execute`) |
| `--output-schema` | | JSON Schema describing expected structured output |
| `--order` | `-o` | Step order (default: 0) |
| `--final` | | Mark as a final step |
| `--transition-to` | `-t` | Steps this can transition to (repeatable) |

The required positional argument is `<name>`. `--workflow` and
`--transition-to` accept full UUIDs or 8-character short IDs. `--json` returns a
creation envelope with `command`, `status`, `step_id`, and `workflow_id`.

`--reasoning-effort` is only valid with the OpenAI/Codex provider. Supported
values are `low`, `medium`, `high`, and `xhigh`; Claude/Anthropic steps reject
the field.

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
3. approved (id: c9d0e1f2, type: execute, model: default) [FINAL]
```

When presenting the data to the user always do so like:
```
step_title (step_id)
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
`name`, `workflow_id`, `order`, `step_type`, `agent_config`, `is_final`,
`transitions_to`, and timestamps. It does not wrap the result in an `output`
field.

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
ID, order, step type, goal, agents, skills, model, output schema, final-step
marker, transitions, and created/updated timestamps. Missing optional fields are
shown as `(none)`, and missing timestamps are shown as `-`.

`--json` returns the raw `Step` object with fields such as `id`, `name`,
`workflow_id`, `order`, `goal`, `prompt`, `agents`, `skills`, `step_type`,
`agent_config`, `output_schema`, `is_final`, `transitions_to`, and timestamps.
It does not wrap the result in an `output` field.

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

# Move a step to Codex and set reasoning effort
vtb step update <step-id> --provider openai --model gpt-5.5 --reasoning-effort high

# Use provider aliases
vtb step update <step-id> --model-provider openai --codex-provider openrouter

# Replace agents list (replaces entire list, not additive)
vtb step update <step-id> --agent .claude/agents/reviewer.md

# Replace skills list (replaces entire list, not additive)
vtb step update <step-id> --skill review --skill simplify

# Replace prompt, step type, and output schema
vtb step update <step-id> --prompt "Review task {{task.id}}"
vtb step update <step-id> --step-type evaluate
vtb step update <step-id> --output-schema '{"type":"object"}'

# Clear all agents
vtb step update <step-id> --clear-agents

# Clear all skills
vtb step update <step-id> --clear-skills

# Clear output schema
vtb step update <step-id> --clear-output-schema

# Clear all transitions
vtb step update <step-id> --clear-transitions

# Change order
vtb step update <step-id> --order 1

# Set or unset final-step marker
vtb step update <step-id> --final true
vtb step update <step-id> --final false

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
| `--agent-config` | | Full agent config as a JSON string |
| `--model` | `-m` | Agent model shortcut |
| `--provider` | | Built-in provider: `anthropic`/`claude` or `openai`/`codex`; alias `--model-provider` |
| `--codex-model-provider` | | Codex upstream provider from `~/.codex/config.toml`; alias `--codex-provider`; only valid when the resulting provider is OpenAI/Codex |
| `--reasoning-effort` | | OpenAI/Codex-only effort: `low`, `medium`, `high`, or `xhigh`; only valid when the resulting provider is OpenAI/Codex |
| `--step-type` | | Step type: `execute`, `evaluate`, `route`, `wait_children`, or `human_input` |
| `--output-schema` | | New output schema as a JSON string |
| `--clear-output-schema` | | Clear the output schema |
| `--order` | `-o` | New 0-indexed step order |
| `--final` | | Set final-step marker to `true` or `false` |
| `--transition-to` | `-t` | Replace transitions list; repeatable |
| `--clear-transitions` | | Clear all transitions |

The required positional argument is `<id>`, the step ID to update. It accepts a
full UUID or an 8-character short ID and resolves case-insensitively.

`--agent`, `--skill`, and `--transition-to` replace their entire existing lists.
Use the matching `--clear-*` flag to persist an empty list. `--agent-config`
can replace the full config, and the shortcut flags (`--provider`, `--model`,
`--codex-model-provider`, and `--reasoning-effort`) overlay individual fields.

`--json` returns an operation envelope with `command`, `status`, and `step_id`.
Invalid `--agent-config` or `--output-schema` JSON fails before persistence.
Provider/model mismatches, Codex upstream provider usage when the resulting
provider is Anthropic, and Anthropic reasoning effort are rejected by the CLI
before the step is updated.

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

### Order
Steps are ordered by their `order` field. Lower values execute first.

### Final Steps
Steps marked `--final` represent completion states. When a task reaches a final step, the workflow is considered complete.

### Transitions
By default, steps can transition to any other step. Use `--transition-to` to restrict valid transitions.

### Agents
Steps can have associated agent files that provide prompts and configuration for AI-assisted execution.

### Skills
Steps can reference skills (slash commands) available during that step.
