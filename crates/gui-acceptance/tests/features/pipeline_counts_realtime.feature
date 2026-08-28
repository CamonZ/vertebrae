Feature: Real-time pipeline aggregate counts
  The All Workflows pipeline view should refresh Sacrum-owned aggregate counts
  when task positions and TaskRun lifecycle state change.

  Scenario: TaskRun lifecycle updates pipeline active counts
    Given I create a workflow with:
      | name | Pipeline Active Workflow |
    And I create a step "Run Count" in the workflow "Pipeline Active Workflow" via the CLI
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Pipeline Active Task     |
      | workflow | Pipeline Active Workflow |
    Then the GUI should show an element with title "1 task(s)" within 10 seconds
    When I start the task workflow via the CLI
    Then the GUI should show an element with title "1 active" within 10 seconds
    When I stop the task workflow via the CLI
    Then the GUI should not show an element with title "1 active" within 10 seconds
