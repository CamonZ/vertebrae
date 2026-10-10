Feature: Failure path step execution
  The mock claude exits non-zero, or exits before its turn's stream-json
  result; the daemon reports a Failed StepExecution whose error surfaces in
  the output.

  Scenario: Failed execution from non-zero exit
    Given a configured daemon test environment
    And a workflow with one inference step
    And a task assigned to the workflow
    When the mock is scripted to exit non-zero with an error message
    And I start a TaskRun
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"

  Scenario: Failed from SIGKILL-like exit code
    Given a configured daemon test environment
    And a workflow with one inference step
    And a task assigned to the workflow
    When the mock is scripted to exit with code 137
    And I start a TaskRun
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And the execution output contains "137"

  Scenario: A turn that exits without a stream-json result line fails
    Given a configured daemon test environment
    And a workflow with one inference step
    And a task assigned to the workflow
    When the mock is scripted to succeed without a result line
    And I start a TaskRun
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And the execution has no recorded metrics

  Scenario: A turn with only stderr output fails
    Given a configured daemon test environment
    And a workflow with one inference step
    And a task assigned to the workflow
    When the mock is scripted to succeed with only stderr output
    And I start a TaskRun
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"

  Scenario: Selected TypeSafe harness reports missing server credentials
    Given a configured daemon test environment
    And a workflow with one inference step using harness "typesafe" and model "jev"
    And a task assigned to the workflow
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And the execution output contains "TypeSafe provider API key is not configured"
