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
  --prompt "Implement the task described in {task.id}" \
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
```

Output:
```
Steps for workflow '<workflow-id>':
1. coding (id: a1b2c3d4, model: sonnet)
2. testing (id: e5f6a7b8, model: haiku)
3. documentation (id: c9d0e1f2, model: haiku)
```

---

## step show

Show detailed step information.

```bash
vtb step show <step-id>
```

Output shows step ID, name, workflow, order, goal, agents, skills, transitions, and timestamps in a flat key-value format.

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

# Replace agents list (replaces entire list, not additive)
vtb step update <step-id> --agent .claude/agents/reviewer.md

# Clear all agents
vtb step update <step-id> --clear-agents

# Clear all skills
vtb step update <step-id> --clear-skills

# Clear all transitions
vtb step update <step-id> --clear-transitions

# Change order
vtb step update <step-id> --order 1
```

---

## step delete

Delete a step.

```bash
vtb step delete <step-id>

# Force delete without confirmation
vtb step delete <step-id> --force
```

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
