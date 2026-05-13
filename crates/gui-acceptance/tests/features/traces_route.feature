Feature: Traces route navigation
  When a user clicks "Explore traces" on the task detail mini view, the
  app should navigate to /traces/:taskId and load the page with the
  correct subtree root.

  Scenario: Navigating from the task detail mini view loads the traces page
    Given I create a workflow with:
      | name | Traces Route Workflow |
    And I create a step "Traces Route Step" in the workflow "Traces Route Workflow" via the CLI
    And the GUI is on the pipeline view
    When I create a task with:
      | title    | Traces Route Root Task |
      | workflow | Traces Route Workflow  |
    Then the GUI should show an element with title "1 task(s)" within 10 seconds
    When I click on the element containing text "Traces Route Step"
    Then the GUI should show "Tasks" within 5 seconds
    When I click on the element containing text "Tasks"
    And I click on the element containing text "Traces Route Root Task"
    Then the GUI should show "Traces Route Root Task" within 5 seconds
    When I click on the element with test id "trace-mini-explore"
    Then the GUI should show "Σ Runs" within 10 seconds
    And the GUI should show "Traces Route Root Task" within 5 seconds
