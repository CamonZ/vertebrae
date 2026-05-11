Feature: Real-time pipeline aggregate counts
  The All Workflows pipeline view should refresh Sacrum-owned aggregate counts
  when task positions and TaskRun lifecycle state change.

  Scenario: Task step move updates pipeline task counts
    Given I create a workflow with:
      | name | Pipeline Move Workflow |
    And I create a step "Move Source" in the workflow "Pipeline Move Workflow" via the CLI
    And I create a step "Move Target" in the workflow "Pipeline Move Workflow" via the CLI
    When I create a task with:
      | title    | Existing Target Task   |
      | workflow | Pipeline Move Workflow |
    And I transition the task to step "Move Target" via the CLI
    And the GUI is on the pipeline view
    When I create a task with:
      | title    | Moving Source Task     |
      | workflow | Pipeline Move Workflow |
    Then the pipeline step "Move Source" should show an element with title "1 task(s)" within 10 seconds
    When I transition the task to step "Move Target" via the CLI
    Then the pipeline step "Move Target" should show an element with title "2 task(s)" within 10 seconds
    And the pipeline step "Move Source" should not show an element with title "1 task(s)" within 10 seconds

  Scenario: TaskRun lifecycle updates pipeline active counts
    Given I create a workflow with:
      | name | Pipeline Active Workflow |
    And I create a step "Run Count" in the workflow "Pipeline Active Workflow" via the CLI
    And the GUI is on the pipeline view
    When I create a task with:
      | title    | Pipeline Active Task     |
      | workflow | Pipeline Active Workflow |
    Then the GUI should show an element with title "1 task(s)" within 10 seconds
    When I start the task workflow via the CLI
    Then the GUI should show an element with title "1 active" within 10 seconds
    When I stop the task workflow via the CLI
    Then the GUI should not show an element with title "1 active" within 10 seconds
