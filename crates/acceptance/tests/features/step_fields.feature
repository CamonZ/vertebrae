Feature: Step fields: prompt and agent-config

  Background:
    Given a configured Sacrum client
    And a workflow "test-wf" with steps "backlog, done"

  Scenario: Create a step with --prompt
    When I add a step "Review" to the workflow with flag "--prompt" and value "Check all tests pass"
    Then the command should succeed
    And the step "Review" in the workflow should have prompt "Check all tests pass"

  Scenario: Create a step with --agent-config JSON sets agent model
    When I add a step "Deploy" to the workflow with --agent-config model "claude-opus-4-6"
    Then the command should succeed
    And the step "Deploy" in the workflow should have agent model "claude-opus-4-6"

  Scenario: --model flag overrides model in --agent-config
    When I add a step "Build" to the workflow with --agent-config model "claude-haiku-4-5-20251001" and --model "claude-opus-4-6"
    Then the command should succeed
    And the step "Build" in the workflow should have agent model "claude-opus-4-6"

  Scenario: Create a Codex step with reasoning effort
    When I add a step "Codex" to the workflow with provider "openai", model "gpt-5.5", and reasoning effort "high"
    Then the command should succeed
    And the step "Codex" in the workflow should have agent_config field "provider" equal to "openai"
    And the step "Codex" in the workflow should have agent model "gpt-5.5"
    And the step "Codex" in the workflow should have agent_config field "reasoning_effort" equal to "high"

  Scenario: Create a Codex step with an upstream model provider
    When I add a step "OpenRouterCodex" to the workflow with provider "openai", codex model provider "openrouter", and model "deepseek/deepseek-v4-flash"
    Then the command should succeed
    And the step "OpenRouterCodex" in the workflow should have agent_config field "provider" equal to "openai"
    And the step "OpenRouterCodex" in the workflow should have agent_config field "codex_model_provider" equal to "openrouter"
    And the step "OpenRouterCodex" in the workflow should have agent model "deepseek/deepseek-v4-flash"

  Scenario: Update a Codex step with an upstream model provider
    When I add a step "ZaiCodex" to the workflow with provider "openai", model "gpt-5.5", and reasoning effort "medium"
    And I update the step "ZaiCodex" in the workflow with provider "openai", codex model provider "zai", and model "glm-5.1"
    Then the command should succeed
    And the step "ZaiCodex" in the workflow should have agent_config field "provider" equal to "openai"
    And the step "ZaiCodex" in the workflow should have agent_config field "codex_model_provider" equal to "zai"
    And the step "ZaiCodex" in the workflow should have agent model "glm-5.1"

  Scenario: Update a Codex step with reasoning effort preserves provider and model
    When I add a step "TunedCodex" to the workflow with provider "openai", model "gpt-5.5", and reasoning effort "medium"
    And I update the step "TunedCodex" in the workflow with flag "--reasoning-effort" and value "xhigh"
    Then the command should succeed
    And the step "TunedCodex" in the workflow should have agent_config field "provider" equal to "openai"
    And the step "TunedCodex" in the workflow should have agent model "gpt-5.5"
    And the step "TunedCodex" in the workflow should have agent_config field "reasoning_effort" equal to "xhigh"

  Scenario: Invalid reasoning effort is rejected
    When I add a step "BadCodex" to the workflow with provider "openai", model "gpt-5.5", and reasoning effort "minimal"
    Then the command should fail with "minimal"

  Scenario: Anthropic step with reasoning effort is rejected
    When I add a step "BadClaude" to the workflow with provider "anthropic", model "opus", and reasoning effort "high"
    Then the command should fail with "only supported with --provider openai"

  Scenario: Anthropic step with Codex upstream model provider is rejected
    When I add a step "BadCodexProvider" to the workflow with provider "anthropic", codex model provider "openrouter", and model "opus"
    Then the command should fail with "only valid with --provider openai"

  Scenario: Codex provider-scoped model without upstream provider is rejected
    When I add a step "BadScopedModel" to the workflow with provider "openai", model "deepseek/deepseek-v4-flash"
    Then the command should fail with "not recognized by the built-in openai catalog"

  Scenario: Invalid --agent-config JSON fails with clear error
    When I add a step "Bad" to the workflow with invalid --agent-config JSON
    Then the command should fail with "--agent-config JSON"

  Scenario: Update a step's prompt
    When I add a step "Review" to the workflow
    And I update the step "Review" in the workflow with flag "--prompt" and value "Updated prompt text"
    Then the command should succeed
    And the step "Review" in the workflow should have prompt "Updated prompt text"

  Scenario: Create a step with --step-type route
    When I add a step "Router" to the workflow with flag "--step-type" and value "route"
    Then the command should succeed
    And the step "Router" in the workflow should have step_type "route"

  Scenario: Create a step with --step-type wait_children
    When I add a step "Barrier" to the workflow with flag "--step-type" and value "wait_children"
    Then the command should succeed
    And the step "Barrier" in the workflow should have step_type "wait_children"

  Scenario: Create a finish step without the legacy final marker
    When I add a step "Complete" to the workflow with flag "--step-type" and value "finish"
    Then the command should succeed
    And the step "Complete" in the workflow should have step_type "finish"
    When I show the step "Complete"
    Then the output should contain "Step Type:     finish"

  Scenario: Create a stop step with exactly one continuation
    When I add a stop step "Pause" to the workflow continuing to "done"
    Then the command should succeed
    And the step "Pause" in the workflow should have step_type "stop"
    When I show the step "Pause"
    Then the output should contain "Step Type:     stop"

  Scenario: Update a step to a stop boundary with one continuation
    When I add a step "PauseUpdate" to the workflow
    And I update the step "PauseUpdate" to stop and continue to "done"
    Then the command should succeed
    And the step "PauseUpdate" in the workflow should have step_type "stop"

  Scenario: Stop step creation requires a continuation
    When I add a step "InvalidPause" to the workflow with flag "--step-type" and value "stop"
    Then the command should fail with "exactly one outgoing transition"

  Scenario: Stop step creation rejects multiple continuations
    When I add a stop step "AmbiguousPause" to the workflow with continuations "backlog" and "done"
    Then the command should fail with "exactly one outgoing transition"

  Scenario: Step show JSON preserves finish step type
    When I add a step "JsonComplete" to the workflow with flag "--step-type" and value "finish"
    And I show the step "JsonComplete" as JSON
    Then the step show JSON should have step_type "finish"

  Scenario: Step show displays human_input step type
    When I add a step "Gate" to the workflow with flag "--step-type" and value "human_input"
    And I show the step "Gate"
    Then the output should contain "Step Type:     human_input"
    And the output should not contain "Step Type:     execute"

  Scenario: Step show JSON preserves human_input step type
    When I add a step "JsonGate" to the workflow with flag "--step-type" and value "human_input"
    And I show the step "JsonGate" as JSON
    Then the step show JSON should have step_type "human_input"

  Scenario: Update a step's step_type to wait_children
    When I add a step "Waiter" to the workflow
    And I update the step "Waiter" in the workflow with flag "--step-type" and value "wait_children"
    Then the command should succeed
    And the step "Waiter" in the workflow should have step_type "wait_children"

  Scenario: Create a step with --step-type evaluate and --output-schema
    When I add a step "Checker" to the workflow with --step-type "evaluate" and --output-schema
    Then the command should succeed
    And the step "Checker" in the workflow should have step_type "evaluate"
    And the step "Checker" in the workflow should have an output_schema

  Scenario: Step type defaults to execute
    When I add a step "Default" to the workflow
    Then the command should succeed
    And the step "Default" in the workflow should have step_type "execute"

  Scenario: Update a step's step_type
    When I add a step "Worker" to the workflow
    And I update the step "Worker" in the workflow with flag "--step-type" and value "evaluate"
    Then the command should succeed
    And the step "Worker" in the workflow should have step_type "evaluate"

  Scenario: Update a step with --output-schema then --clear-output-schema
    When I add a step "Evaluator" to the workflow with --step-type "evaluate" and --output-schema
    And I update the step "Evaluator" in the workflow with flag "--clear-output-schema" and no value
    Then the command should succeed
    And the step "Evaluator" in the workflow should not have an output_schema

  Scenario: Configure, replace, and clear a deterministic route
    When I add and configure a deterministic route step "Router" to the workflow
    Then the command should succeed
    And the step "Router" in the workflow should have step_type "route"
    When I show the step "Router"
    Then the output should contain "Step Type:     route"
    And the output should contain "Route Config:"
    And the output should contain "match_policy"
    When I show the step "Router" as JSON
    Then the step show JSON should contain the deterministic route config
    When I replace the route config for step "Router"
    Then the command should succeed
    When I show the step "Router" as JSON
    Then the step show JSON should contain the replacement route config
    When I update the step "Router" in the workflow with flag "--clear-route-config" and no value
    Then the command should succeed
    When I show the step "Router" as JSON
    Then the step show JSON should have null route_config

  Scenario: Route drafts and local route JSON validation
    When I add a step "DraftRouter" to the workflow with flag "--step-type" and value "route"
    Then the command should succeed
    And the step "DraftRouter" in the workflow should have step_type "route"
    When I show the step "DraftRouter"
    Then the output should contain "Route Config:   (none)"
    When I update the step "DraftRouter" in the workflow with flag "--route-config" and value "{bad json}"
    Then the command should fail with "--route-config JSON"

  Scenario: Backend route validation keeps the offending path
    When I add and configure a deterministic route step "InvalidRouter" to the workflow
    And I update the configured route step "InvalidRouter" with an invalid reference
    Then the command should fail with "$.rules[0].when.ref"
    And the error should contain "route_config"

  Scenario: Retained route prompts are readable and clear-only
    When I create a route step "RetainedPrompt" with a retained prompt
    And I show the step "RetainedPrompt"
    Then the output should contain "Prompt:        retained prompt"
    When I show the step "RetainedPrompt" as JSON
    Then the step show JSON should have prompt "retained prompt"
    When I update the step "RetainedPrompt" in the workflow with flag "--clear-prompt" and no value
    Then the command should succeed
    When I show the step "RetainedPrompt" as JSON
    Then the step show JSON should have null prompt
    When I update the step "RetainedPrompt" in the workflow with flag "--prompt" and value "replacement prompt"
    Then the command should fail with "route steps"

  Scenario: Converting a configured route requires an atomic clear
    When I add and configure a deterministic route step "ConvertRouter" to the workflow
    And I update the step "ConvertRouter" in the workflow with flag "--step-type" and value "execute"
    Then the command should fail with "route_config"
    When I convert the configured route step "ConvertRouter" to execute and clear its route config
    Then the command should succeed
    And the step "ConvertRouter" in the workflow should have step_type "execute"

  Scenario: Structured-output persistence options round-trip and display
    When I add a step "Persisted" to the workflow with persistence logical name "step_result"
    Then the command should succeed
    And the step "Persisted" in the workflow should have persistence logical name "step_result"
    When I update the step "Persisted" in the workflow with persistence logical name "latest_result"
    Then the command should succeed
    And the step "Persisted" in the workflow should have persistence logical name "latest_result"
    When I show the step "Persisted"
    Then the output should contain "Persistence:"
    When I show the step "Persisted" as JSON
    Then the step show JSON should have persistence logical name "latest_result"

  Scenario: Invalid persistence JSON is rejected before mutation
    When I add a step "BadPersistenceJson" to the workflow with flag "--persistence-options" and value "{bad json}"
    Then the command should fail with "--persistence-options JSON"

  Scenario: Persistence requires an output schema
    When I add a step "MissingSchemaPersistence" to the workflow with persistence but no output schema
    Then the command should fail with "output_schema"

  Scenario: Unknown persistence keys are rejected by Sacrum
    When I add a step "UnknownPersistenceKey" to the workflow with an unknown persistence key
    Then the command should fail with "persistence"

  Scenario: Blank persistence logical names are rejected by Sacrum
    When I add a step "BlankPersistenceName" to the workflow with a blank persistence logical name
    Then the command should fail with "logical_name"

  Scenario: Overlong persistence logical names are rejected by Sacrum
    When I add a step "LongPersistenceName" to the workflow with an overlong persistence logical name
    Then the command should fail with "logical_name"
