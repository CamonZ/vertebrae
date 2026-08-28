Feature: Traces page renders session log content end-to-end
  After a workflow run produces session log entries, opening /traces/:taskId
  should render the unified chat view with the recorded assistant message —
  not the empty-state placeholder. This is the only acceptance scenario that
  exercises the full daemon → mock-claude → Sacrum → GUI data path; the
  other traces scenarios only verify navigation and empty-state rendering.

  Scenario: Unified chat view renders the assistant message text
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Traces Content Workflow |
    And I create a step "Traces Content Step" in the workflow "Traces Content Workflow" via the CLI
    And the step prompt is set to a mock that emits an assistant message "hello-from-mock-claude"
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Traces Content Root Task |
      | workflow | Traces Content Workflow  |
    And I start the task workflow via the CLI
    And I wait up to 30 seconds for the task to have a completed execution
    When I navigate to the traces page for the created task
    Then the GUI should show an element with test id "unified-chat-view" within 10 seconds
    And the GUI should show "hello-from-mock-claude" within 10 seconds
