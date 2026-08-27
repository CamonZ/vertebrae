Feature: Structured output persistence options
  Sacrum owns persistence configuration and creates task artifacts after the
  daemon reports validated structured output.

  Scenario: Successful structured output creates a visible task artifact
    Given a configured daemon test environment
    And a workflow with one execute step and an output schema
    And the step is configured with persistence logical name "step_result"
    And a task assigned to the workflow
    When the mock emits valid fenced JSON with surrounding prose
    And I orchestrate the task
    And I wait for the execution to reach status "completed"
    Then the task artifact "step_result" has body containing "answer"
    And the task has exactly 1 artifact named "step_result"

  Scenario: Schema-invalid output does not create a task artifact
    Given a configured daemon test environment
    And a workflow with one execute step and an output schema
    And the step is configured with persistence logical name "step_result"
    And a task assigned to the workflow
    When the mock is scripted to emit output that violates the schema
    And I orchestrate the task
    And I wait for the execution to reach status "failed"
    Then the task has no artifact named "step_result"

  Scenario: Successful persistence replaces an existing logical artifact
    Given a configured daemon test environment
    And a workflow with one execute step and an output schema
    And the step is configured with persistence logical name "step_result"
    And a task assigned to the workflow
    And the task has an existing artifact named "step_result"
    When the mock emits valid fenced JSON with surrounding prose
    And I orchestrate the task
    And I wait for the execution to reach status "completed"
    Then the task artifact "step_result" has body containing "answer"
    And the task has exactly 1 artifact named "step_result"
