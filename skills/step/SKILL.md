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
vtb step add "Review" -w <workflow-id> --harness claude

# With goal and model
vtb step add "Coding" -w <workflow-id> --harness claude --goal "Implement the feature" --model sonnet

# Codex/OpenAI with per-step reasoning effort
vtb step add "Coding" -w <workflow-id> --harness codex \
  --provider openai \
  --model gpt-5.5 \
  --reasoning-effort high

# Codex with serving speed, personality, and output detail
vtb step add "Codex review" -w <workflow-id> --harness codex \
  --provider openai \
  --model gpt-5.5 \
  --speed-tier fast \
  --personality pragmatic \
  --verbosity high

# Codex/OpenAI with a configured upstream provider
vtb step add "Coding" -w <workflow-id> --harness codex \
  --provider openai \
  --codex-model-provider openrouter \
  --model deepseek/deepseek-v4-flash

# With prompt and full agent config JSON
vtb step add "Coding" -w <workflow-id> --harness claude \
  --prompt "Implement the task described in {{task.id}}" \
  --agent-config '{"model":"opus","max_budget_usd":5.0}'

# With agents and skills
vtb step add "Testing" -w <workflow-id> --harness claude \
  --agent .claude/agents/test-runner.md \
  --skill run-tests \
  --skill check-coverage

# With transitions and a finish step
vtb step add "Approved" -w <workflow-id> --harness claude --step-type finish
vtb step add "Needs Work" -w <workflow-id> --harness claude --transition-to <step-id>

# Continue the draft step's conversation in the next llm_inference step
vtb step add "Draft" -w <workflow-id> --harness claude \
  --transition-to <revise-step-id> \
  --transition-session <revise-step-id>=resume

# With step type and structured output schema
vtb step add "Evaluate" -w <workflow-id> --harness claude \
  --step-type llm_inference \
  --output-schema '{"type":"object","required":["passed"],"properties":{"passed":{"type":"boolean"}}}'

# Add a structured_inference step: provider, model, state, and fields are
# required; state may be JSON or a string template, fields may be @file
vtb step add "Classify" -w <workflow-id> --harness typesafe \
  --step-type structured_inference \
  --provider typesafe \
  --model <model> \
  --state '{"title":"{{ task.title }}"}' \
  --fields @classify-schema.json

# Create a deterministic route draft, then configure it after graph targets exist
vtb step add "Router" -w <workflow-id> --harness claude --step-type route
vtb step update <step-id> --route-config '<route-config-json>'

# Persist validated structured output as a task artifact (Sacrum-owned)
vtb step add "Evaluate" -w <workflow-id> --harness claude \
  --step-type llm_inference \
  --output-schema '{"type":"object","required":["passed"]}' \
  --persistence-options '{"artifact":{"logical_name":"step_result"}}'

# Machine-readable creation result
vtb --json step add "Review" -w <workflow-id> --harness claude
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
| `--model` | `-m` | Model to use; `config.model` for `structured_inference` steps |
| `--provider` | | Built-in provider: `anthropic`/`claude` or `openai`/`codex`; alias `--model-provider`. For `structured_inference` steps, any non-blank provider name (`config.provider`) |
| `--state` | | `structured_inference` input: JSON object/array/string or a string template (`{{ dotted.path }}`); `@path` reads a file |
| `--fields` | | `structured_inference` output JSON Schema, inline or `@path` |
| `--codex-model-provider` | | Codex upstream provider from `~/.codex/config.toml`; alias `--codex-provider` |
| `--reasoning-effort` | | OpenAI/Codex-only effort: `low`, `medium`, `high`, or `xhigh` |
| `--speed-tier` | | Provider serving speed preference: `default` or `fast` |
| `--personality` | | Provider style identifier; Codex accepts `none`, `friendly`, or `pragmatic` when supported by the selected model |
| `--verbosity` | | Output detail level: `low`, `medium`, or `high`; alias `--output-verbosity`; currently valid with OpenAI/Codex |
| `--step-type` | | Step type: `llm_inference`, `structured_inference`, `route`, `wait_children`, `human_input`, `stop`, or `finish` (default: `llm_inference`) |
| `--output-schema` | | JSON Schema describing expected structured output |
| `--route-config` | | Opaque deterministic route configuration as a JSON string; only valid for `route` steps |
| `--persistence-options` | | Sacrum-owned JSON configuration for persisting structured output as a task artifact |
| `--order` | `-o` | Step order (default: 0) |
| `--transition-to` | `-t` | Steps this can transition to (repeatable) |
| `--transition-session` | | Session directive for one outgoing transition: `<TO>=<new\|resume\|fork>[:<STEP>]` (repeatable) |
| `--children-session` | | `wait_children` only: `fork:<STEP>`, the parent conversation every child run forks |
| `--instructions` | | `human_input` only: instructions template shown while the gate waits, inline or `@path` |
| `--artifact` | | `human_input` only: logical name of the artifact that resolves the gate |

The required positional argument is `<name>`. `--workflow`,
`--transition-to`, and the step IDs in `--transition-session` accept full UUIDs
or 8-character short IDs. `--json` returns a
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

`--transition-session <TO>=<MODE>[:<STEP>]` sets how the `llm_inference` step
`<TO>` enters a conversation when a run follows this step's transition to it;
`<TO>` must be one of the `--transition-to` destinations. `<STEP>` is the step
whose conversation is resumed or forked and defaults to `<TO>`; it is rejected
with `new`. See [Session directives](#session-directives).

`--children-session fork:<STEP>` is only valid for `wait_children` steps: every
child run the step creates forks the conversation of `<STEP>`, an
`llm_inference` step of this workflow, in the parent run. Sacrum accepts only
`fork` and requires `<STEP>`. See [Session directives](#session-directives).

`human_input` steps take `--instructions`, `--artifact`, and `--output-schema`,
all optional. Sacrum renders the instructions when the run parks; attaching an
artifact with that logical name to the waiting execution resolves the gate once
its body satisfies the output schema.

`structured_inference` steps take only `--provider`, `--model`, `--state`, and
`--fields`, and Sacrum requires all four on create. Agent, prompt, and output
schema flags are rejected for them, and `--state`/`--fields` are rejected for
every other step type.

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
1. coding (id: a1b2c3d4, type: llm_inference, model: sonnet)
2. testing (id: e5f6a7b8, type: llm_inference, model: haiku)
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
`name`, `workflow_id`, `order`, `step_type`, `config`,
`persistence_options`, `transitions_to`, `transition_sessions`, and
timestamps. `transition_sessions` maps a destination step ID to its
transition's directive (`{"mode": "resume"}`,
`{"mode": "fork", "step_id": "<step-id>"}`) and is omitted when no transition
carries one. It does not wrap the result in an `output` field.

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
as `-`. A configured route also lists each decision's session directive under
`Route Sessions:`, one line per rule (`rules[<i>] <id>`) and the default:
`new`, `resume destination`, `fork step <step-id>`, or `(none)`. When any
outgoing transition carries a directive, `Transition Sessions:` follows
`Transitions:` with one `-> <step-id>: <directive>` line per transition in the
same wording. A `wait_children` step shows `Children Session:` as
`fork step <step-id>` or `(none)`.

`--json` returns the raw `Step` object with fields such as `id`, `name`,
`workflow_id`, `order`, `goal`, `step_type`, `config`, `persistence_options`,
`transitions_to`, `transition_sessions`, and timestamps. A `wait_children`
step's `config.session` is `{"mode": "fork", "step_id": "<step-id>"}` when set.
It does not wrap the result in an `output` field.

`route_config` is nullable opaque JSON. An empty object is distinct from `null`;
the CLI preserves the value without interpreting or normalizing the route AST,
so rule and default `session` directives appear exactly as saved in `step show`
and `step list` JSON.

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
vtb step update <step-id> --harness codex --provider openai --model gpt-5.5 --reasoning-effort high

# Use provider aliases
vtb step update <step-id> --model-provider openai --codex-provider openrouter

# Replace agents list (replaces entire list, not additive)
vtb step update <step-id> --agent .claude/agents/reviewer.md

# Replace skills list (replaces entire list, not additive)
vtb step update <step-id> --skill review --skill simplify

# Update prompt and output schema on an inference step
vtb step update <step-id> --prompt "Review task {{task.id}}"
vtb step update <step-id> --output-schema '{"type":"object"}'

# Clear a retained prompt
vtb step update <step-id> --clear-prompt

# Replace a structured_inference step's output schema; provider, model, and
# state keep their values
vtb step update <step-id> --fields @classify-schema.json

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
| `--model` | `-m` | Agent model shortcut; `config.model` for `structured_inference` steps |
| `--provider` | | Built-in provider: `anthropic`/`claude` or `openai`/`codex`; alias `--model-provider`. `config.provider` for `structured_inference` steps |
| `--state` | | New `structured_inference` state (JSON, string template, or `@path`) |
| `--fields` | | New `structured_inference` output JSON Schema (inline or `@path`) |
| `--codex-model-provider` | | Codex upstream provider from `~/.codex/config.toml`; alias `--codex-provider`; only valid when the resulting provider is OpenAI/Codex |
| `--reasoning-effort` | | OpenAI/Codex-only effort: `low`, `medium`, `high`, or `xhigh`; only valid when the resulting provider is OpenAI/Codex |
| | `--output-schema` | | New output schema as a JSON string |
| `--clear-output-schema` | | Clear the output schema |
| `--route-config` | | Replace the opaque deterministic route configuration |
| `--clear-route-config` | | Clear the route configuration, leaving a route draft |
| `--persistence-options` | | Replace Sacrum's persistence configuration with JSON |
| `--clear-persistence-options` | | Clear the persistence configuration (send `null`) |
| `--order` | `-o` | New 0-indexed step order |
| `--transition-to` | `-t` | Replace transitions list; repeatable |
| `--clear-transitions` | | Clear all transitions |
| `--transition-session` | | Set one outgoing transition's session directive, `<TO>=<new\|resume\|fork>[:<STEP>]`, or clear it with `<TO>=none`; repeatable |
| `--children-session` | | `wait_children` only: set the fork every child run enters with, `fork:<STEP>` |
| `--clear-children-session` | | `wait_children` only: clear it; children start new conversations |
| `--instructions` / `--clear-instructions` | | `human_input` only: replace or clear the instructions, inline or `@path` |
| `--artifact` / `--clear-artifact` | | `human_input` only: replace or clear the resolving artifact's logical name |
| `--speed-tier` | | New provider serving speed preference: `default` or `fast` |
| `--personality` | | New provider style identifier; Codex accepts `none`, `friendly`, or `pragmatic` when supported by the selected model |
| `--verbosity` | | New output detail level: `low`, `medium`, or `high`; alias `--output-verbosity`; currently valid with OpenAI/Codex |
| `--clear-speed-tier` | | Remove the stored speed preference |
| `--clear-personality` | | Remove the stored personality |
| `--clear-verbosity` | | Remove the stored output verbosity |

The required positional argument is `<id>`, the step ID to update. It accepts a
full UUID or an 8-character short ID and resolves case-insensitively.

A transition kept by `--transition-to` keeps its label and session directive.
`--transition-session` changes only the transitions it names, which must be
among the step's resulting transitions, so it can be used alone:

```bash
vtb step update <draft-step-id> --transition-session <revise-step-id>=resume
vtb step update <draft-step-id> --transition-session <revise-step-id>=fork:<other-step-id>
vtb step update <draft-step-id> --transition-session <revise-step-id>=none
```

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
For a `route` step, `--prompt` and `--output-schema` are rejected. Route configuration is semantically validated by Sacrum, and
nested diagnostics retain
their `route_config` field paths, such as `$.rules[0].session.step_id` for a
rejected session directive. Sacrum rejects an invalid transition directive with
the `$.session` path and the transition's endpoints. Clearing route configuration leaves an
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
a configured route to that state. Route steps accept only `route_config` inside their config. They cannot
be converted from another step type; create a new route step instead.

### Session directives

Every `llm_inference` execution runs in a provider conversation. How it enters
one is chosen by the path that led to it, never by the step: there are no
session flags or config fields on `llm_inference` steps. Three carriers hold the
same `session` directive:

- A route decision: each rule and the default may carry `session` beside
  `transition` and `handoff`. Use it when the continuation depends on the
  route's outcome (loop back and resume on `needs_changes`, start fresh on
  `approved`). An `inter_workflow` decision may resume or fork a conversation
  of the route's own workflow in the destination workflow's entry step.
- A step transition: an outgoing edge into an `llm_inference` step may carry
  one, authored with `--transition-session`. Use it for a fixed continuation,
  such as consecutive `llm_inference` steps that share one conversation with
  different prompts, without a route step between them. Transitions leaving a
  route step cannot carry one; the route's decisions own those. The edge
  leaving a `stop` step is entered by the next TaskRun and continues the
  conversation of the run that stopped there.
- A `wait_children` step: `--children-session fork:<STEP>` gives every child
  run it creates a fork of the parent run's `<STEP>` conversation, entered by
  the child workflow's first step.

```json
{
  "id": "needs_changes",
  "when": {"ref": "previous_output.verdict", "op": "eq", "value": "needs_changes"},
  "transition": {"type": "intra_workflow", "step_id": "<implement-step-id>"},
  "handoff": {"feedback": "{{ previous_output.explanation }}"},
  "session": {"mode": "resume"}
}
```

```bash
vtb step update <draft-step-id> --transition-to <revise-step-id> \
  --transition-session <revise-step-id>=resume
```

An `inter_workflow` decision must name the step, because the destination's
entry step is chosen when the route runs:

```json
{
  "id": "handoff",
  "when": {"ref": "previous_output.verdict", "op": "eq", "value": "ready"},
  "transition": {"type": "inter_workflow", "workflow_id": "<review-workflow-id>"},
  "session": {"mode": "resume", "step_id": "<implement-step-id>"}
}
```

```bash
vtb step add "Wait for children" -w <workflow-id> --step-type wait_children \
  --harness claude --children-session fork:<plan-step-id>
vtb step update <wait-step-id> --clear-children-session
```

- `mode` is `new`, `resume`, or `fork`.
  - `new` starts a fresh conversation.
  - `resume` continues a conversation as its next turn.
  - `fork` starts a new conversation that branches from a conversation's
    latest turn and leaves the original untouched.
- `step_id` (the `:<STEP>` of `--transition-session`) names the step whose
  conversation is resumed or forked. It defaults to the destination step and is
  not allowed with `new`.
- A step entered without a directive (the first step, a transition or decision
  without `session`) starts a new conversation, so every `llm_inference`
  execution records a native session id that a later path can resume or fork.
- Resume follows a conversation across steps within one TaskRun. A step's
  conversation is the one its latest completed execution belongs to, and the
  resumed turn is that conversation's latest one, whichever step added it: if
  A starts a conversation and B resumes it, resuming A later continues after
  B's turn. Failed executions are never resumed.
- Only the directly linked run is searched: the same TaskRun (route decisions,
  transitions, and `inter_workflow` decisions, which keep the run), the run
  that stopped at a `stop` step (for the edge leaving it, entered by the next
  run), and the parent run (for `wait_children` children). No other run is
  ever resumed.
- Children only fork, so no two runs take turns in one provider conversation;
  siblings fork independently and the parent's later turns are unaffected.
  The fork applies to every child of the step; per-child selection is not
  supported.
- Resume and fork need the same harness: the destination and the `step_id`
  step must be `llm_inference` steps on one harness. Within a workflow this is
  checked on save; for an `inter_workflow` destination or a child's entry step
  it is checked at dispatch (`session_harness_mismatch`).
- A resume or fork that reaches a step other than `llm_inference` (an
  `inter_workflow` destination or a child workflow whose entry step is, say,
  `human_input`) fails the TaskRun with `dispatch_failed`, its reason the step
  id (Sacrum logs `session_requires_llm_inference`).
- Claude stores sessions per working directory. A Claude child forks only a
  parent conversation it can find from its own directory, so keep children in
  the parent's checkout rather than in their own worktree; Codex threads are
  not scoped by directory.
- Nothing resumable fails instead of starting fresh. A step with no completed
  execution in the searched run (for a stop step's edge, the run that stopped
  there) fails the TaskRun with `dispatch_failed` (its reason is the step id;
  Sacrum logs `session_not_found`) without launching the provider, and a
  provider that no longer has the conversation fails the execution with its
  reason.
- One conversation never runs two turns at once. Give parallel branches
  `fork`, not concurrent `resume`s of one conversation.

Sacrum validates directives when they are saved: unknown keys or modes,
`step_id` with `new`, a directive whose destination is not an `llm_inference`
step (for routes, an `intra_workflow` one), and a `step_id` that is not an
`llm_inference` step of the same workflow on the destination's harness are
rejected. An `inter_workflow` decision's `resume` or `fork` without `step_id`
fails with `$.rules[<i>].session.step_id: is required with mode resume or fork`,
and one naming a step outside the route's workflow, or not `llm_inference`,
with `must be an llm_inference step in this workflow`. Route directives report
the `$.rules[<i>].session` or `$.default.session` path; transition directives
report `$.session`, including one on a transition leaving a route step. A
`wait_children` session reports `$.session.mode: must be fork` for `resume` or
`new`, `$.session.step_id: is required` without a step, and
`$.session.step_id: must be an llm_inference step in this workflow` for a step
outside the workflow or of another type. In workflow bundles the directive's
step is written as `session.step_ref`, in the route config (for `intra_workflow`
and `inter_workflow` decisions), on `step_edges[].session`, and in a
`wait_children` step's `config.session`, and resolved back to `session.step_id`
on import.

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
A transition into an `llm_inference` step may carry a session directive; see
[Session directives](#session-directives).

### Agents
Steps can have associated agent files that provide prompts and configuration for AI-assisted execution.

### Skills
Steps can reference skills (slash commands) available during that step.
