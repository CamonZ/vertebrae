Feature: Real-time TaskRun updates on task detail
  TaskRun websocket events should update the open task detail controls from
  payload run_controls without requiring a full task refetch.

  Scenario: TaskRun websocket update changes task detail run controls
    Given I create a workflow with:
      | name | TaskRun Detail Workflow |
    And I create a step "run" in the workflow "TaskRun Detail Workflow" via the CLI
    And the step is marked final via the CLI
    And the GUI is on the pipeline view
    When I create a task with:
      | title    | TaskRun Detail Task     |
      | workflow | TaskRun Detail Workflow |
    Then the GUI should show an element with title "1 task(s)" within 10 seconds
    When I click on the element containing text "run"
    Then the GUI should show "Tasks" within 5 seconds
    When I click on the element containing text "Tasks"
    And I click on the element containing text "TaskRun Detail Task"
    Then the GUI should show "TaskRun Detail Task" within 5 seconds
    When I start the task workflow via the CLI
    Then the GUI should show an element with title "Stop the running orchestrator for this task" within 10 seconds
    When I stop the task workflow via the CLI
    Then the GUI should show a disabled element with title "Stop the running orchestrator for this task" within 10 seconds
