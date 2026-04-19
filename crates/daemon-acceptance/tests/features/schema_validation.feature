Feature: Schema validation failure
  When a step has an output_schema and the mock output violates it,
  the daemon marks the execution Failed. The orchestrator decides what to
  do next — the daemon just surfaces the failure.

  Scenario: Output does not match schema
    Given a configured daemon test environment
    And a workflow with one execute step and an output schema
    And a task assigned to the workflow
    When the mock is scripted to emit output that violates the schema
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And the execution output contains "schema"

  Scenario: Schema declared but step produces no output
    Given a configured daemon test environment
    And a workflow with one execute step and an output schema
    And a task assigned to the workflow
    When the mock is scripted to succeed without a result line
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And the execution output contains "no JSON output"

  Scenario: Fenced JSON payload is malformed
    Given a configured daemon test environment
    And a workflow with one execute step and an output schema
    And a task assigned to the workflow
    When the mock is scripted to emit malformed JSON inside a fence
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And the execution output contains "invalid JSON"

  Scenario: Valid fenced JSON surrounded by prose is accepted
    Given a configured daemon test environment
    And a workflow with one execute step and an output schema
    And a task assigned to the workflow
    When the mock emits valid fenced JSON with surrounding prose
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
