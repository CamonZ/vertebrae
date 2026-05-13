Feature: Step detail panel fetches tasks on demand
  Selecting a step on the AllWorkflowsPipeline view should fetch only that
  step's tasks (no project-wide listTasks on mount) and display them in the
  Tasks tab of the StepDetailPanel.

  Scenario: Clicking a step with tasks renders them in the Tasks tab
    Given I create a workflow with:
      | name | Step Tasks Workflow |
    And I create a step "Triage" in the workflow "Step Tasks Workflow" via the CLI
    And I create a task with:
      | title    | First Triage Task   |
      | workflow | Step Tasks Workflow |
    And I create a task with:
      | title    | Second Triage Task  |
      | workflow | Step Tasks Workflow |
    And the GUI is on the pipeline view
    Then the GUI should show "Triage" within 10 seconds
    When I click on the element with test id "step-node-Triage"
    Then the GUI should show "Step Configuration" within 5 seconds
    When I click on the element containing text "Tasks"
    Then the GUI should show "First Triage Task" within 10 seconds
    And the GUI should show "Second Triage Task" within 10 seconds
