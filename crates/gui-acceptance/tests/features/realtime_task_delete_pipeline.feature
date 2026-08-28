Feature: Real-time task deletion on pipeline view
  When a task is deleted via the CLI, the step's task count badge should
  disappear from the pipeline view in real-time.

  Scenario: Task deleted via CLI decreases step count on pipeline view
    Given I create a workflow with:
      | name | Pipeline Delete Workflow |
    And I create a step "To Do" in the workflow "Pipeline Delete Workflow" via the CLI
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Pipeline Task To Delete  |
      | workflow | Pipeline Delete Workflow |
    Then the GUI should show an element with title "1 task(s)" within 10 seconds
    When I delete the task via the CLI
    Then the GUI should not show an element with title "1 task(s)" within 10 seconds
