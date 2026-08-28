Feature: Real-time task creation on pipeline view
  When a task is created via the CLI and assigned to a workflow, the step's
  task count badge should appear on the pipeline view in real-time.

  Scenario: Task created via CLI appears on pipeline view
    Given I create a workflow with:
      | name | Pipeline Task Workflow |
    And I create a step "To Do" in the workflow "Pipeline Task Workflow" via the CLI
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Pipeline Create Test Task |
      | workflow | Pipeline Task Workflow    |
    Then the GUI should show an element with title "1 task(s)" within 10 seconds
