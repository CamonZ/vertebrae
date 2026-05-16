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

  Scenario: Creating a route step with invalid output schema fails
    When I add a route step "BadRoute" to the workflow with an invalid --output-schema
    Then the command should fail with "routing contract schema"

  Scenario: Create a route step with the with-handoff routing contract schema
    When I add a route step "HandoffRoute" to the workflow with the with-handoff schema
    Then the command should succeed
    And the step "HandoffRoute" in the workflow should have step_type "route"
    And the step "HandoffRoute" in the workflow should have a handoff property in its output_schema

  Scenario: Update a route step to switch to the with-handoff schema
    When I add a step "SwapRoute" to the workflow with --step-type "route" and --output-schema
    And I update the route step "SwapRoute" to use the with-handoff schema
    Then the command should succeed
    And the step "SwapRoute" in the workflow should have a handoff property in its output_schema

  Scenario: Step show displays step type and output schema
    When I add a step "Visible" to the workflow with --step-type "route" and --output-schema
    And I show the step "Visible"
    Then the output should contain "Step Type:     route"
    And the output should contain "Output Schema:"
