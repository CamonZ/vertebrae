Feature: Codex structured-output JSON parsing
  When a Codex step is configured with an output_schema, the daemon launches
  `codex exec --json --output-schema <file>` and the final agent_message.text
  is contractually a JSON document conforming to the schema. The daemon must
  parse that text into a structured value and surface it through the
  execution `output` field. When the text fails to parse as JSON despite a
  clean exit, the step must be marked failed with the underlying serde_json
  error message reaching downstream consumers.

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

  Scenario: Malformed JSON despite exit 0 fails the step with serde_json error
    Given a configured daemon test environment
    And a workflow with one execute step using openai and an output schema
    And a task assigned to the workflow
    When the codex mock is scripted to emit a malformed JSON agent_message
    And run_step is invoked
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And the execution output contains "schema_validation_failure"
    And the execution output contains "expected"
