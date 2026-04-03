Feature: Real-time task update on kanban board
  When a task title is updated via the CLI, the new title should appear
  on the kanban board in real-time without requiring a page reload.

  Scenario: Task title updated via CLI reflects on kanban board in real-time
    Given I create a workflow with:
      | name          | Board Update Workflow |
      | kanban_column | Board Update Column   |
    And I create a step "Test Step" in the workflow "Board Update Workflow" via the CLI
    And the GUI is on the kanban board
    When I create a task with:
      | title    | Board Original Title  |
      | workflow | Board Update Workflow |
    Then the GUI should show "Board Original Title" within 10 seconds
    When I update the task title to "Board Updated Title" via the CLI
    Then the GUI should show "Board Updated Title" within 10 seconds
