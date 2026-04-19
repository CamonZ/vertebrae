Feature: Happy path step execution
  The daemon receives run_step, spawns the mock claude, parses the
  stream-json result, and reports a Completed StepExecution in Sacrum
  with metrics and result text.

  Scenario: Completed execution with metrics
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When the mock is scripted to succeed with full metrics
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution output contains "computed-answer"
    And the execution records input_tokens 1500 and output_tokens 200
    And the execution records positive duration_ms
    And the execution records a non-zero cost

  Scenario: Completed execution without a stream-json result line
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When the mock is scripted to succeed without a result line
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution has no recorded output
    And the execution has no recorded metrics

  Scenario: Every stdout line produces a session log entry
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When the mock is scripted to emit three stream-json lines
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution has 3 session log entries

  Scenario: Completed with only stderr output
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When the mock is scripted to succeed with only stderr output
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution has no recorded output
    And the execution has 0 session log entries
