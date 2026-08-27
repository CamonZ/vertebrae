# Steps

### Managing Steps

```bash
# Add a step to an existing workflow
vtb step add "Testing" -w <workflow-id> \
  --goal "Verify implementation" \
  --model sonnet \
  --order 1

# Add a finish step (completes the task when reached)
vtb step add "Approved" -w <workflow-id> --step-type finish

# Add a stop boundary (ends this run and continues to the one target later)
vtb step add "Pause Run" -w <workflow-id> --step-type stop \
  --transition-to <next-step-id>

# Add step with transition restrictions
vtb step add "Needs Work" -w <workflow-id> --transition-to <step-id>

# Add step with prompt and agent config
vtb step add "Coding" -w <workflow-id> \
  --prompt "Implement the task described in {{task.id}}" \
  --agent-config '{"model":"opus","max_budget_usd":5.0}'

# Add step with agents and skills
vtb step add "Review" -w <workflow-id> \
  --agent .claude/agents/reviewer.md \
  --skill review \
  --skill simplify

# Add step with step type and output schema
vtb step add "Evaluate" -w <workflow-id> \
  --step-type evaluate \
  --output-schema '{"type":"object","required":["passed"],"properties":{"passed":{"type":"boolean"}}}'

# Persist validated structured output as a task artifact (Sacrum-owned)
vtb step add "Evaluate" -w <workflow-id> \
  --step-type evaluate \
  --output-schema '{"type":"object","required":["passed"]}' \
  --persistence-options '{"artifact":{"logical_name":"step_result"}}'

# Add a human-input gate
vtb step add "Needs Input" -w <workflow-id> --step-type human_input

# Add a routing step
vtb step add "Router" -w <workflow-id> --step-type route

# Add a promptless terminal step
vtb step add "Complete" -w <workflow-id> --step-type finish

# Machine-readable creation result
vtb --json step add "Review" -w <workflow-id>

# List, show, update, delete steps
vtb step list <workflow-id>
vtb --json step list <workflow-id>
vtb step show <step-id>
vtb step update <step-id> --goal "New goal" --model opus
vtb step update <step-id> --prompt "New prompt for {{task.id}}"
vtb step update <step-id> --step-type evaluate
vtb step update <step-id> --step-type stop --transition-to <next-step-id>
vtb step update <step-id> --output-schema '{"type":"object"}'
vtb step update <step-id> --clear-output-schema
vtb step update <step-id> --persistence-options '{"artifact":{"logical_name":"step_result"}}'
vtb step update <step-id> --clear-persistence-options
vtb step update <step-id> --clear-agents --clear-skills
vtb --json step update <step-id> --step-type finish
vtb step delete <step-id>
vtb step delete <step-id> --force
vtb --json step delete <step-id>
```

`vtb step add` takes a required `<name>` positional argument plus required
`--workflow` / `-w`; run `vtb step add --help` for the complete creation flag
list. `--transition-to` accepts full UUIDs or 8-character short IDs. The global
`--json` flag returns a creation envelope with `command`, `status`, `step_id`,
and `workflow_id`.

`vtb step list` takes exactly one required `<workflow>` argument and no
command-specific flags. `vtb step list --help` shows only the global `--json`
flag plus `-h` / `--help`. Human-readable output is ordered by each step's
`order` field and includes the step name, ID, type, and model:

```text
Steps for workflow '<workflow-id>':
1. coding (id: a1b2c3d4, type: execute, model: sonnet)
2. testing (id: e5f6a7b8, type: evaluate, model: haiku)
3. approved (id: c9d0e1f2, type: finish, model: default)
```

When the workflow has no steps, it prints `No steps found for workflow
'<workflow-id>'`. With the global `--json` flag, `step list` returns the raw
array of step objects and does not wrap the response in an `output` field.

`vtb step show` takes exactly one required `<id>` argument: the step ID to show.
It accepts a full UUID or an 8-character hex short ID and resolves IDs
case-insensitively. The command has no aliases, defaults, or value enums; its
help lists only `<ID>`, `--json`, and `-h` / `--help`.

Human-readable output is a flat detail view with the step ID and name, workflow
ID, order, step type, goal, agents, skills, model, output schema, transitions,
and created/updated timestamps:

```text
Step: 925c50ac-a1ed-4f5b-82c3-9dcb0773597b - implement
============================================================

Workflow:      84b28cbb-9c65-4d64-9ea0-b74587f9d056
Order:         1
Step Type:     execute
Goal:          Implement the ticket in the assigned worktree.
Agents:        (none)
Skills:        (none)
Model:         gpt-5.5
Output Schema: (none)
Transitions:   57d373b1-e40d-4a42-9ae4-1c6461d7a2b9
Created:       2026-05-29 12:53
Updated:       2026-05-30 16:48
```

Missing optional fields are shown as `(none)`, and missing timestamps are shown
as `-`. If a full UUID reaches `step show` but no matching step exists, the
command fails with `Step not found: <id>`. If an 8-character hex short ID cannot
be resolved, the shared ID resolver reports `step with prefix '<id>' not found`.

With the global `--json` flag, `step show` returns the raw `Step` object and
does not wrap the response in an `output` field:

```bash
vtb --json step show <step-id>
```

The JSON object includes fields such as `id`, `name`, `workflow_id`, `order`,
`goal`, `prompt`, `agents`, `skills`, `step_type`, `agent_config`,
`output_schema`, `transitions_to`, `created_at`, and `updated_at`.
When configured, `persistence_options` is also included; it is `null`/absent
for steps without persistence configuration.

`vtb step update` takes exactly one required `<id>` argument: the step ID to
update. It accepts a full UUID or an 8-character hex short ID and resolves IDs
case-insensitively. Every command-specific flag is optional, so running
`vtb step update <step-id>` with no property flags is accepted and performs a
request with no property changes before reporting success.

| Flag | Short | Behavior |
|------|-------|----------|
| `--name <NAME>` | | Replace the step name |
| `--goal <GOAL>` | `-g` | Replace the step goal |
| `--agent <AGENT>` | `-a` | Replace the full agents list; repeat for multiple agents |
| `--clear-agents` | | Replace the agents list with an empty list |
| `--skill <SKILL>` | `-s` | Replace the full skills list; repeat for multiple skills |
| `--clear-skills` | | Replace the skills list with an empty list |
| `--prompt <PROMPT>` | | Replace the execution prompt |
| `--agent-config <JSON>` | | Replace/overlay the full agent config from a JSON string |
| `--model <MODEL>` | `-m` | Set `agent_config.model` |
| `--provider <PROVIDER>` | | Set `agent_config.provider`; accepts `anthropic`/`claude` or `openai`/`codex`; alias `--model-provider` |
| `--codex-model-provider <PROVIDER>` | | Set `agent_config.codex_model_provider`; alias `--codex-provider`; only valid when the resulting provider is OpenAI/Codex |
| `--reasoning-effort <EFFORT>` | | Set `agent_config.reasoning_effort`; valid values are `low`, `medium`, `high`, and `xhigh`; only valid when the resulting provider is OpenAI/Codex |
| `--step-type <STEP_TYPE>` | | Set the step type; values are `execute`, `evaluate`, `route`, `wait_children`, `human_input`, `stop`, and `finish` |
| `--output-schema <JSON>` | | Replace the step output schema from a JSON string |
| `--clear-output-schema` | | Remove the output schema |
| `--persistence-options <JSON>` | | Replace Sacrum's persistence configuration |
| `--clear-persistence-options` | | Remove the persistence configuration |
| `--order <ORDER>` | `-o` | Replace the 0-indexed step order |
| `--transition-to <STEP_ID>` | `-t` | Replace the full transitions list; repeat for multiple target steps |
| `--clear-transitions` | | Replace the transitions list with an empty list |

For replacement-list fields, update is not additive: any provided `--agent`,
`--skill`, or `--transition-to` values replace the existing list. The matching
`--clear-*` flags win for that field when present. `--agent-config` starts from
the supplied JSON; the shortcut flags (`--provider`, `--model`,
`--codex-model-provider`, and `--reasoning-effort`) then overlay individual
fields before the config is validated and persisted.

Invalid JSON in `--agent-config`, `--output-schema`, or `--persistence-options`
fails before persistence. Sacrum validates persistence configuration and
surfaces errors for blank/overlong logical names, unknown keys, missing
`output_schema`, and terminal `finish`/`stop` steps.
Provider/model mismatches, Codex upstream provider usage when the resulting
provider is Anthropic, and Anthropic reasoning effort are rejected by the CLI
before the step is updated.
If a full UUID reaches `step update` but no matching step exists, the command
fails with `Step not found: <id>`. If an 8-character hex short ID cannot be
resolved, the shared ID resolver reports `step with prefix '<id>' not found`.

Human-readable success output is:

```text
Updated step: <step-id>
```

With the global `--json` flag, `step update` returns an operation envelope:

```json
{
  "command": "step update",
  "status": "updated",
  "step_id": "<step-id>"
}
```

`vtb step delete` takes exactly one required `<id>` argument: the step ID to
delete. It accepts a full UUID or an 8-character hex short ID and resolves IDs
case-insensitively. Its only command-specific flag is `--force` / `-f`.
Deletion does not prompt for confirmation today, so `--force` is accepted for
compatibility with delete-style commands rather than changing behavior.

Human-readable success output is:

```text
Deleted step: <step-id>
```

With the global `--json` flag, `step delete` returns an operation envelope:

```json
{
  "command": "step delete",
  "status": "deleted",
  "step_id": "<step-id>"
}
```

The JSON `step_id` is lowercased. If a full UUID reaches `step delete` but no
matching step exists, the command fails with `Step not found: <id>`. If an
8-character hex short ID cannot be resolved, the shared ID resolver reports
`step with prefix '<id>' not found`.

### Step Properties

| Property | Description |
|----------|-------------|
| `name` | Step name (e.g., "backlog", "coding", "review") |
| `order` | Execution order (lower = first, 0-indexed) |
| `step_type` | `finish` marks the task complete when reached |
| `goal` | What this step accomplishes |
| `prompt` | Template sent to the executing agent (supports `{{task.id}}` interpolation) |
| `model` | AI model shortcut (sonnet, haiku, opus) |
| `agent-config` | Full LLM config JSON (model, budget, tools, permissions) |
| `provider` | Built-in execution provider shortcut (`anthropic`/`claude` or `openai`/`codex`); `--model-provider` is an alias |
| `codex-model-provider` | Codex upstream provider shortcut from `~/.codex/config.toml`; `--codex-provider` is an alias |
| `reasoning-effort` | OpenAI/Codex reasoning effort (`low`, `medium`, `high`, `xhigh`) |
| `agents` | Agent file paths for AI-assisted execution |
| `skills` | Slash commands available during this step |
| `transition-to` | Restrict which steps can follow this one |
| `step-type` | Type of step: `execute`, `evaluate`, `route`, `wait_children`, `human_input`, `stop`, or `finish` (see below) |
| `output-schema` | JSON Schema for structured output enforcement (see below) |

### Step Types

Each step has a `--step-type` that determines its role in the workflow:

| Type | Description |
|------|-------------|
| `execute` | **Default.** Runs the step's prompt via Claude and produces output. |
| `evaluate` | Assesses the output of a previous step. Used with `eval_prompt` to determine which transition to follow when a step has multiple outgoing paths. |
| `route` | Directs work to different paths based on conditions. Uses a fixed routing contract schema. |
| `wait_children` | Parent/child orchestration barrier — pauses the parent until all child tasks complete. Handled server-side by Sacrum; the daemon does not execute this step type directly. |
| `human_input` | Human review/input gate. The workflow pauses for external input instead of dispatching a daemon execution. |
| `stop` | Run boundary. Ends the current TaskRun as `stopped` without completing the task or dispatching the step; it must have exactly one outgoing transition, which a later TaskRun follows. |
| `finish` | Promptless terminal step. Completes the task immediately, has no outgoing transitions, and is never dispatched to a daemon executor. |

```bash
# Set step type on creation
vtb step add "Eval" -w <wf-id> --step-type evaluate

# Create a human-input gate
vtb step add "Needs Input" -w <wf-id> --step-type human_input

# Create a promptless terminal step
vtb step add "Complete" -w <wf-id> --step-type finish

# Create a stop boundary with one continuation
vtb step add "Pause Run" -w <wf-id> --step-type stop --transition-to <next-step-id>

# Change step type later
vtb step update <step-id> --step-type route
```

When a step has type `evaluate` and multiple outgoing transitions, the daemon runs a separate evaluation execution whose output is matched against transition labels to determine the next step — creating a **branching state machine** driven by AI judgment.

`finish` is the sole terminal step type. Its prompt, agent configuration, output
schema, and outgoing transitions must be empty. Sacrum owns task completion and
dependent-task readiness; the daemon and GUI render that backend state and treat
finish as a completion event rather than an AI execution.

`stop` is a run boundary, not a completion step and not the same as the operator
`vtb stop-taskrun` control. When the orchestrator reaches it, Sacrum stops the
current TaskRun with `outcome_kind=run_boundary`, leaves the task incomplete, and
does not dispatch the stop step. A later TaskRun bypasses the stop through its
single outgoing transition. The CLI and client reject stop steps unless exactly
one outgoing transition is provided.

The seven step types are carried unchanged through the Sacrum API, core models,
CLI JSON output, Tauri bindings, Atlas/task-location surfaces, and trace
normalization. Unknown future wire values remain available through the
`unsupported` compatibility variant.

### Output Schemas

Steps can define an `output_schema` — a JSON Schema describing the expected structured output from the selected harness. When present:

- The daemon passes it to the selected harness subprocess, enforcing structured output
- The step-level `output_schema` takes precedence over `agent_config.json_schema`
- This enables reliable machine-readable responses for evaluation steps, routing decisions, and automated pipeline stages

```bash
# Set output schema on creation
vtb step add "Eval" -w <wf-id> --step-type evaluate \
  --output-schema '{"type":"object","required":["summary","passed"],"properties":{"summary":{"type":"string"},"passed":{"type":"boolean"}}}'

# Update output schema
vtb step update <step-id> --output-schema '{"type":"object"}'

# Clear output schema
vtb step update <step-id> --clear-output-schema
```

### Persistence Options

Steps may ask Sacrum's orchestrator to persist validated structured output as a
named JSON artifact attached to the current task:

```json
{"artifact":{"logical_name":"step_result"}}
```

The `logical_name` must be nonblank and at most 255 characters. Artifact
persistence requires an `output_schema`; Sacrum rejects unknown keys and
rejects persistence on `finish` and `stop` steps. `execute`, `evaluate`,
`route`, `human_input`, and `wait_children` outputs/snapshots are persisted by
Sacrum, with repeated writes upserting the task's
`<logical_name>.json` artifact. The daemon only executes and validates output;
it does not interpret this setting or create artifacts.

### Provider Selection (Anthropic / OpenAI)

Each step picks the harness (the local CLI) that will run its prompt via
`agent_config.provider`. The MVP ships with two built-in providers:

| Provider | Harness | Binary | Transport | Provider-binary lookup env var |
|----------|---------|--------|-----------|--------------------------------|
| `anthropic` (default) | Claude Code streaming harness | `claude` | persistent stream-json session | `CLAUDE_CODE_PATH` |
| `openai` | Codex App Server streaming harness | `codex` | App Server WebSocket | `CODEX_PATH` |

Both harnesses emit the same normalized `HarnessEventV1` stream, which the
daemon persists as `format=harness` session logs and the GUI replays through
one projection — so a step's provider changes which CLI runs, not how its
output is stored or rendered. See
[Architecture — Harness Crates](../architecture.md#harness-crates) for crate
ownership and how to add a third provider.

When `provider` is unset on a step, the daemon defaults to **Anthropic** to
preserve pre-refactor behavior. The daemon resolves the harness binary by
checking the provider-specific env var first, then the user's login-shell
`PATH`, then well-known install locations (`~/.local/bin`, `/usr/local/bin`,
`/opt/homebrew/bin`).

> **Authentication is the harness's job, not Vertebrae's.** The daemon does not
> read `ANTHROPIC_API_KEY`, `OPENAI_API_KEY`, or any other vendor credential
> directly. Each provider authenticates through its own CLI's existing
> mechanism — typically `claude login` for Claude Code and `codex login` (or
> the equivalent vendor env var the harness itself reads) for Codex. Run the
> harness once interactively, confirm it works standalone, then point
> Vertebrae at it.

#### Setting the provider on a step

`vtb step add` and `vtb step update` accept `--provider` (alias:
`--model-provider`), `--model`, `--codex-model-provider` (alias:
`--codex-provider`), and `--reasoning-effort` as convenience shortcuts that
overlay the step's `agent_config`:

```bash
# Default behavior — provider unset, daemon uses Anthropic / Claude Code
vtb step add "Coding" -w <wf-id> --model sonnet

# Explicit Anthropic with a Claude model
vtb step add "Coding" -w <wf-id> \
  --provider anthropic \
  --model claude-sonnet-4-20250514

# OpenAI / Codex with a GPT model (alias --model-provider also works)
vtb step add "Coding" -w <wf-id> \
  --model-provider openai \
  --model gpt-5.5 \
  --reasoning-effort high

# Codex harness with an OpenRouter upstream provider configured in ~/.codex/config.toml
vtb step add "Coding" -w <wf-id> \
  --provider openai \
  --codex-model-provider openrouter \
  --model deepseek/deepseek-v4-flash

# Codex harness with a Z.ai upstream provider configured in ~/.codex/config.toml
vtb step add "Coding" -w <wf-id> \
  --provider openai \
  --codex-provider zai \
  --model glm-5.1

# Switch an existing step over to Codex
vtb step update <step-id> --provider openai --model o3-mini --reasoning-effort high

# Drop back to Anthropic
vtb step update <step-id> --provider anthropic --model opus
```

Accepted provider names (case-insensitive): `anthropic` / `claude`,
`openai` / `codex`.

For Codex steps, `provider=openai` selects the local Codex harness. It does not
necessarily mean the upstream model API is OpenAI. Set
`codex_model_provider` with `--codex-model-provider` when Codex should use a
custom upstream provider from `~/.codex/config.toml`; Vertebrae passes it as
The daemon sends `model_provider` through the Codex App Server initialization
request. Keep API keys and bearer tokens in Codex config or environment, not
in Vertebrae task data.

Reasoning effort is OpenAI/Codex-only. Valid values are `low`, `medium`,
`high`, and `xhigh`; unsupported values such as `minimal` are rejected. A step
with `--provider anthropic` / Claude plus `--reasoning-effort` is rejected
before persistence or execution.

#### Recognized model aliases

The CLI validates the `(provider, model)` pair against a small built-in
catalog before persisting the step:

- **Anthropic:** the bare aliases `opus`, `sonnet`, `haiku`, plus any
  `claude-*` / `claude` model name.
- **OpenAI:** any `gpt-*` / `gpt` model, the reasoning aliases `o<digit>...`
  (e.g. `o1`, `o1-mini`, `o3`, `o3-mini`, `o4-mini`), and `codex-*` / `codex`.

Mismatched pairs (e.g. `--provider openai --model claude-opus-4-5`) are
rejected at the CLI with an actionable error. Unknown model names are also
rejected unless `--provider openai` is paired with `--codex-model-provider`,
which tells Vertebrae to leave provider-scoped model IDs such as
`deepseek/deepseek-v4-flash` or `glm-5.1` to Codex. `codex_model_provider` is
rejected with `--provider anthropic` because Claude Code does not understand
Codex upstream provider profiles. `--agent-config` is still useful when you
need to set provider/model together with lower-level config fields:

```bash
vtb step update <step-id> \
  --agent-config '{"provider":"openai","codex_model_provider":"openrouter","model":"deepseek/deepseek-v4-flash","reasoning_effort":"high","max_budget_usd":5.0}'
```

#### Local smoke test

The end-to-end smoke path exercises both providers. It assumes the daemon was
installed through the GUI onboarding flow and the relevant harness CLI is
logged in.

```bash
# 0. Confirm the harnesses Vertebrae will spawn are reachable.
which claude   # or set CLAUDE_CODE_PATH
which codex    # or set CODEX_PATH
claude --version
codex --version

# 1. Anthropic / Claude default behavior.
#    Provider is unset on the step, so the daemon picks Anthropic and runs `claude`.
vtb workflow add "Smoke-Claude" --step Hello:sonnet
vtb add "Smoke: Claude default" -d "say hi"
vtb workflow assign <task-id> <smoke-claude-wf-id>
vtb run <task-id>
# Confirm the run in the GUI or by watching daemon logs.

# 2. OpenAI / Codex provider selection.
#    Separate workflow whose single step targets Codex/gpt-5.5.
vtb workflow add "Smoke-Codex"
vtb step add "Hello" -w <smoke-codex-wf-id> \
  --provider openai \
  --model gpt-5.5 \
  --reasoning-effort high \
  --prompt "Reply with the single word: ok"
vtb add "Smoke: Codex" -d "say hi"
vtb workflow assign <task-id-2> <smoke-codex-wf-id>
vtb run <task-id-2>
# Confirm the run in the GUI or by watching daemon logs.
```

Each smoke task uses a single-step workflow so the run is unambiguous about
which provider the daemon resolved. The resolved provider and model are
persisted on the `StepExecution` record (and reported back to the backend); the
CLI does not expose StepExecution detail output, so confirm the harness was
actually used by tailing the daemon logs or by inspecting the spawned process
while the run is in flight.

#### Out of scope for the MVP

The current tranche is intentionally CLI-driven. The following are **not**
supported and should not be assumed to work:

- **GUI profile editing.** Provider/model selection is set via `vtb step
  add` / `vtb step update` only. The GUI does not yet expose a profile editor.
- **Remote or durable workers.** The daemon runs locally and spawns local
  harness binaries. Remote daemon routing, durable worker registration, and
  claim/lease assignment are not implemented.
- **Arbitrary harness profiles.** Only the two built-in providers
  (`anthropic`, `openai`) are recognized. User-owned harness profile
  registries and arbitrary binary profiles are deferred.
- **Storing secrets in Sacrum.** API keys, login tokens, and other vendor
  credentials must remain with the harness CLI on the local machine. Sacrum
  does not store, proxy, or distribute provider secrets.

---
