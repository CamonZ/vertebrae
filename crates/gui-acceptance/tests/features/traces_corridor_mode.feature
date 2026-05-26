Feature: Traces CORRIDOR mode renders the subtree as a DAG
  When a user opens /traces/:taskId and switches the mode toggle to
  CORRIDOR, the center pane should render a pannable / zoomable DAG
  canvas where step executions are nodes — NOT the placeholder.

  Scenario: CORRIDOR mode shows the DAG canvas for a subtree root
    Given I create a workflow with:
      | name | Corridor Mode Workflow |
    And I create a step "Corridor Mode Step" in the workflow "Corridor Mode Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Corridor Mode Root Task |
      | workflow | Corridor Mode Workflow  |
    Then the GUI should show "Corridor Mode Root Task" within 10 seconds
    When I click on the element containing text "Corridor Mode Root Task"
    Then the GUI should show "Corridor Mode Root Task" within 5 seconds
    When I click on the element with test id "trace-mini-explore"
    Then the GUI should show "Σ Runs" within 10 seconds
    When I click on the element with test id "trace-mode-option-corridor"
    Then the GUI should show an element with test id "corridor-view" within 10 seconds
