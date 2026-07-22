Feature: Codex App Server step execution
  The daemon receives run_step for a step whose provider is openai, launches
  the configured Codex App Server, exchanges JSON-RPC messages over WebSocket,
  and reports the normalized result in Sacrum.

  Scenario: Codex completed execution with metrics
    Given a configured daemon test environment
    And a workflow with one execute step using openai
    And a task assigned to the workflow
    When the codex mock is scripted to succeed with full metrics
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the Codex App Server uses the persistent session RPC flow
    And the execution output contains "codex-final-answer"
    And the execution records input_tokens 1500 and output_tokens 800

  Scenario: Codex request carries model and reasoning effort
    Given a configured daemon test environment
    And a workflow with one execute step using openai and reasoning effort "high"
    And a task assigned to the workflow
    When the codex mock is scripted to succeed with full metrics
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the Codex App Server request contains model "gpt-5.5" and reasoning effort "high"

  Scenario: Codex request carries an upstream model provider
    Given a configured daemon test environment
    And a workflow with one execute step using openai, codex model provider "openrouter", and model "deepseek/deepseek-v4-flash"
    And a task assigned to the workflow
    When the codex mock is scripted to succeed with full metrics
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the Codex App Server request contains model "deepseek/deepseek-v4-flash" and model provider "openrouter"

  Scenario: Codex completed without an agent_message
    Given a configured daemon test environment
    And a workflow with one execute step using openai
    And a task assigned to the workflow
    When the codex mock is scripted to succeed without an agent_message
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution has no recorded output
    And the execution has no recorded metrics

  Scenario: Codex item events become session log entries
    Given a configured daemon test environment
    And a workflow with one execute step using openai
    And a task assigned to the workflow
    When the codex mock is scripted to emit three jsonl item events
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution has at least 3 session log entries
    And the execution session logs contain normalized harness events only

  Scenario: Codex top-level error event reports failure
    Given a configured daemon test environment
    And a workflow with one execute step using openai
    And a task assigned to the workflow
    When the codex mock is scripted to emit an error event
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"

  Scenario: Codex failed turn reports failure
    Given a configured daemon test environment
    And a workflow with one execute step using openai
    And a task assigned to the workflow
    When the codex mock is scripted to emit a turn.failed event
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
