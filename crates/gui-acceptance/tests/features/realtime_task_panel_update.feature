Feature: Real-time task detail panel updates
  When a task is modified via the CLI, its open detail panel should reflect
  the changes in real-time without requiring a page reload.

  Scenario: Task title update reflects in open task detail panel
    Given I create a workflow with:
      | name | Task Panel Workflow |
    And I create a step "Task Panel Step" in the workflow "Task Panel Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Original Task Panel Title |
      | workflow | Task Panel Workflow       |
    Then the GUI should show "Original Task Panel Title" within 10 seconds
    When I click on the element containing text "Original Task Panel Title"
    Then the GUI should show "Original Task Panel Title" within 5 seconds
    When I update the task title to "Updated Task Panel Title" via the CLI
    Then the GUI should show "Updated Task Panel Title" within 10 seconds
