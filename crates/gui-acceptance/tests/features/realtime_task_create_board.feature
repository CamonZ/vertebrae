Feature: Real-time task creation on kanban board
  When a task is created via the CLI and assigned to a workflow that has a
  kanban column, it should appear on the kanban board in real-time without
  requiring a page reload.

  Scenario: Task created via CLI appears on kanban board
    Given I create a workflow with:
      | name          | Board Task Workflow |
      | kanban_column | Board Test Column   |
    And I create a step "Test Step" in the workflow "Board Task Workflow" via the CLI
    And the GUI is on the kanban board
    When I create a task with:
      | title    | Board Create Test Task |
      | workflow | Board Task Workflow    |
    Then the GUI should show "Board Create Test Task" within 10 seconds
