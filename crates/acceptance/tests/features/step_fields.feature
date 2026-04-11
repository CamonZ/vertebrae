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

  Scenario: Invalid --agent-config JSON fails with clear error
    When I add a step "Bad" to the workflow with invalid --agent-config JSON
    Then the command should fail with "--agent-config JSON"

  Scenario: Update a step's prompt
    When I add a step "Review" to the workflow
    And I update the step "Review" in the workflow with flag "--prompt" and value "Updated prompt text"
    Then the command should succeed
    And the step "Review" in the workflow should have prompt "Updated prompt text"

