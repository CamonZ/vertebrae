Feature: Codex structured-output JSON parsing
  When a Codex step is configured with an output_schema, the daemon sends it
  in the App Server turn request and parses the final agent message as JSON.
  Invalid JSON must fail the step even when the App Server reports completion.

  Scenario: Structured JSON agent_message succeeds with parsed value visible
    Given a configured daemon test environment
    And a workflow with one execute step using openai and an output schema
    And a task assigned to the workflow
    When the codex mock is scripted to emit a structured JSON agent_message
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the execution output contains "verdict"
    And the execution output contains "approved"
    And the execution output contains "0.92"

  Scenario: Malformed JSON despite App Server completion fails the step
    Given a configured daemon test environment
    And a workflow with one execute step using openai and an output schema
    And a task assigned to the workflow
    When the codex mock is scripted to emit a malformed JSON agent_message
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And the execution output contains "schema_validation_failure"
    And the execution output contains "expected"
