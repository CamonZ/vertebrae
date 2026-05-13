Feature: Stop a running workflow from the GUI
  Drive the full GUI + daemon stack: from the task detail panel, click
  Run Workflow to start the orchestrator (vtb-daemon picks up the run_step
  event and launches a sleeping mock claude), then click Stop midway and
  verify the Stop button disappears as the orchestrator terminates.

  Scenario: Click Run Workflow then Stop while the mock is mid-sleep
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Stop GUI Workflow |
    And I create a step "run" in the workflow "Stop GUI Workflow" via the CLI
    And the step is marked final via the CLI
    And the step prompt is set to a mock that sleeps 15000 milliseconds
    And the GUI is on the pipeline view
    When I create a task with:
      | title    | Stop GUI Task     |
      | workflow | Stop GUI Workflow |
    Then the GUI should show an element with title "1 task(s)" within 10 seconds
    When I click on the element with test id "step-node-run"
    Then the GUI should show "Tasks" within 5 seconds
    When I click on the element containing text "Tasks"
    And I click on the element containing text "Stop GUI Task"
    Then the GUI should show "Stop GUI Task" within 5 seconds
    When I click on the element with title "Run the entire workflow for this task"
    Then the GUI should show an element with title "Stop the running orchestrator for this task" within 15 seconds
    When I click on the element with title "Stop the running orchestrator for this task"
    Then the GUI should not show an element with title "Stop the running orchestrator for this task" within 15 seconds
