Feature: Real-time pipeline aggregate counts
  The All Workflows pipeline view should refresh Sacrum-owned aggregate counts
  when task positions and TaskRun lifecycle state change.

  Scenario: Task step move updates pipeline task counts
    Given I create a workflow with:
      | name | Pipeline Move Workflow |
    And I create a step "Move Source" in the workflow "Pipeline Move Workflow" via the CLI
    And I create a step "Move Target" in the workflow "Pipeline Move Workflow" via the CLI
    And the GUI is on the pipeline view
    Then the GUI should show an element with test id "step-node-Move Target" within 10 seconds
    When I click on the element with test id "step-node-Move Target"
    Then the GUI should show "Step Configuration" within 5 seconds
    When I click on the element with test id "step-detail-tab-tasks"
    Then the GUI element with test id "step-detail-tab-tasks-count" should have text "0" within 10 seconds
    And the GUI element with test id "step-detail-tasks-content" should contain text "No tasks assigned to this step" within 10 seconds
    When I create a task with:
      | title    | Moving Source Task     |
      | workflow | Pipeline Move Workflow |
    When I transition the task to step "Move Target" via the CLI
    Then the GUI element with test id "step-detail-tab-tasks-count" should have text "1" within 10 seconds
    And the GUI element with test id "step-detail-tasks-content" should contain text "Moving Source Task" within 10 seconds

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
