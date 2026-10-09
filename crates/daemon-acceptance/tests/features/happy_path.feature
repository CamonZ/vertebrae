Feature: Happy path step execution
  The daemon receives run_step, spawns the mock claude, parses the
  stream-json result, and reports a Completed StepExecution in Sacrum
  with metrics and result text.

  Scenario: Explicit Claude step harness uses the Claude runtime
    Given a configured daemon test environment
    And a workflow with one inference step using harness "claude" and model "claude-sonnet-4-6"
    And a task assigned to the workflow
    When the mock is scripted to succeed with full metrics
    And I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution output contains "computed-answer"
    And the execution records input_tokens 1500 and output_tokens 200

  @skip
  Scenario: Completed execution with metrics
    Given a configured daemon test environment
    And a workflow with one inference step
    And a task assigned to the workflow
    When the mock is scripted to succeed with full metrics
    And I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution output contains "computed-answer"
    And the execution records input_tokens 1500 and output_tokens 200
    And the execution records positive duration_ms
    And the execution records a non-zero cost

  Scenario: Every stdout line produces a session log entry
    Given a configured daemon test environment
    And a workflow with one inference step
    And a task assigned to the workflow
    When the mock is scripted to emit three stream-json lines
    And I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution has at least 3 session log entries
