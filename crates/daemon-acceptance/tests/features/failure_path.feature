Feature: Failure path step execution
  Exit-code-based failure: the mock claude exits non-zero; the daemon
  reports a Failed StepExecution whose error surfaces in the output.

  Scenario: Failed execution from non-zero exit
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When the mock is scripted to exit non-zero with an error message
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"

  Scenario: Failed from SIGKILL-like exit code
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When the mock is scripted to exit with code 137
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And the execution output contains "137"
