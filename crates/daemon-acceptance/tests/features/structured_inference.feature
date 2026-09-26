Feature: Structured inference execution through TypeSafe
  The daemon sends Sacrum-resolved state and System One questions through the
  structured harness API and completes the execution with TypeSafe's answers.

  @structured_inference
  Scenario: TypeSafe structured inference completes and advances its TaskRun
    Given a stub TypeSafe server returning structured answers
    And a configured daemon test environment
    And a workflow with one structured_inference step using TypeSafe
    And a task assigned to the workflow
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution output contains "priority"
    And the execution output contains "0.9"
    And the execution records input_tokens 41 and output_tokens 8
    And the task is complete
