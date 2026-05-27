Feature: Traces THREAD mode renders a unified chat across the subtree
  When a user opens /traces/:taskId and the THREAD mode toggle is active,
  the center pane should render one continuous scrollable conversation
  spanning every execution in the subtree, with sticky workflow/step
  section dividers between executions — NOT one isolated scroll box per
  execution.

  Scenario: THREAD mode shows a unified chat surface for a subtree root
    Given I create a workflow with:
      | name | Thread Mode Workflow |
    And I create a step "Thread Mode Step" in the workflow "Thread Mode Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Thread Mode Root Task |
      | workflow | Thread Mode Workflow  |
    Then the GUI should show "Thread Mode Root Task" within 10 seconds
    When I click on the element containing text "Thread Mode Root Task"
    Then the GUI should show "Thread Mode Root Task" within 5 seconds
    When I click on the element with test id "trace-mini-explore"
    Then the GUI should show "Σ Runs" within 10 seconds
    And the GUI should show an element with test id "unified-chat-view" within 10 seconds
