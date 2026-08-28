Feature: Real-time task update on pipeline view
  When a task title is updated via the CLI, the step's task count badge should
  remain on the pipeline view (task stays assigned to the step).

  Scenario: Task updated via CLI stays in step on pipeline view
    Given I create a workflow with:
      | name | Pipeline Update Workflow |
    And I create a step "To Do" in the workflow "Pipeline Update Workflow" via the CLI
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Pipeline Original Title  |
      | workflow | Pipeline Update Workflow |
    Then the GUI should show an element with title "1 task(s)" within 10 seconds
    When I update the task title to "Pipeline Updated Title" via the CLI
    Then the GUI should show an element with title "1 task(s)" within 10 seconds
