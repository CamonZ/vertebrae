Feature: Real-time task deletion on kanban board
  When a task is deleted via the CLI, it should disappear from the
  kanban board in real-time without requiring a page reload.

  Scenario: Task deleted via CLI disappears from kanban board in real-time
    Given I create a workflow with:
      | name          | Board Delete Workflow |
      | kanban_column | Board Delete Column   |
    And I create a step "Test Step" in the workflow "Board Delete Workflow" via the CLI
    And the GUI is on the kanban board
    When I create a task with:
      | title    | Board Task To Delete  |
      | workflow | Board Delete Workflow |
    Then the GUI should show "Board Task To Delete" within 10 seconds
    When I delete the task via the CLI
    Then the GUI should not show "Board Task To Delete" within 10 seconds
