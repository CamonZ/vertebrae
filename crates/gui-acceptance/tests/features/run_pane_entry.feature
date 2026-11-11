Feature: Open a task's run in the chat
  Clicking "Open in chat" on the task detail mini view opens the chat panel
  maximized with the task's run rendered read-only in a pane, one headed
  section per step execution.

  Scenario: Opening a run from the task detail mini view shows a run pane
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Run Pane Entry Workflow |
    And I create a step "Run Pane Entry Step" in the workflow "Run Pane Entry Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Run Pane Entry Task     |
      | workflow | Run Pane Entry Workflow |
    And I start the task workflow via the CLI
    Then the GUI should show "Run Pane Entry Task" within 10 seconds
    When I click on the element containing text "Run Pane Entry Task"
    Then the GUI should show "Run Pane Entry Task" within 5 seconds
    When I click on the element with test id "task-detail-runs-in-chat"
    Then the GUI should show an element with test id "run-pane" within 10 seconds
    And the element with test id "run-pane-title" should read "Run Pane Entry Task" within 10 seconds
