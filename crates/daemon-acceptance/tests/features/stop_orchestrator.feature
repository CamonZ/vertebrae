Feature: Stop a running orchestrator
  The GUI's Stop button calls Sacrum's stop_orchestrator(task_id) mutation.
  Sacrum terminates the TaskOrchestrator FSM, which propagates a cancel
  to the daemon's StepExecutor; the daemon kills the running mock and
  the step_execution lands in a failed state.

  Scenario: Stop orchestrator mid-run
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When the mock is scripted to sleep 15000 milliseconds
    And I orchestrate the task
    And Sacrum receives stop_orchestrator for the task
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
