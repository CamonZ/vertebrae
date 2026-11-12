Feature: Run panes render session log content end-to-end
  After a workflow run produces session log entries, opening the task's run
  in the chat should render the run pane with the recorded assistant message,
  not the empty-state placeholder. This exercises the full
  daemon → mock-claude → Sacrum → GUI data path.

  Scenario: Run pane renders the assistant message text
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Run Pane Content Workflow |
    And I create a step "Run Pane Content Step" in the workflow "Run Pane Content Workflow" via the CLI
    And the step prompt is set to a mock that emits an assistant message "hello-from-mock-claude"
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Run Pane Content Root Task |
      | workflow | Run Pane Content Workflow  |
    And I start the task workflow via the CLI
    And I wait up to 30 seconds for the task to have a completed execution
    When I open the created task's run in the chat
    Then the GUI should show an element with test id "run-pane" within 10 seconds
    And the GUI should show "hello-from-mock-claude" within 10 seconds
