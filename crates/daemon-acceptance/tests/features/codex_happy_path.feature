Feature: Codex JSONL step execution
  The daemon receives run_step for a step whose provider is openai,
  spawns the mock codex, parses `codex exec --json` output, and reports
  a Completed (or Failed) StepExecution in Sacrum with metrics, output,
  and session log entries derived from the JSONL stream.

  Scenario: Codex completed execution with metrics
    Given a configured daemon test environment
    And a workflow with one execute step using openai
    And a task assigned to the workflow
    When the codex mock is scripted to succeed with full metrics
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution output contains "codex-final-answer"
    And the execution records input_tokens 1700 and output_tokens 800

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

  Scenario: Codex emits multiple item events as session log entries
    Given a configured daemon test environment
    And a workflow with one execute step using openai
    And a task assigned to the workflow
    When the codex mock is scripted to emit three jsonl item events
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution has 3 session log entries

  Scenario: Codex top-level error event reports failure
    Given a configured daemon test environment
    And a workflow with one execute step using openai
    And a task assigned to the workflow
    When the codex mock is scripted to emit an error event
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"

  Scenario: Codex turn.failed event reports failure
    Given a configured daemon test environment
    And a workflow with one execute step using openai
    And a task assigned to the workflow
    When the codex mock is scripted to emit a turn.failed event
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
