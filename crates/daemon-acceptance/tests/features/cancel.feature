Feature: Cancel a running step
  The mock sleeps long enough for the daemon to receive a cancel_step
  broadcast. The daemon kills the child process and records a Failed
  execution (the daemon maps the cancel to a failed execution with an
  error message).

  Scenario: Cancel mid-sleep
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When the mock is scripted to sleep 15000 milliseconds
    And run_step is invoked
    And Sacrum broadcasts cancel_step for the running execution
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
