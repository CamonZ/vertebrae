Feature: Traces sidebar entry and task picker
  The Sidebar exposes a Traces nav item that opens /traces. With no task
  selected, the page renders the same full layout as /traces/:taskId
  with a task picker rail in place of the subtree. Selecting a task in
  the picker navigates to /traces/:taskId. From a loaded /traces/:taskId,
  the subtree rail header offers a "Switch" affordance that swaps the
  rail in-place with the picker for picking a different task.

  Background:
    Given I create a workflow with:
      | name | Sidebar Picker Workflow |
    And I create a step "Sidebar Picker Step" in the workflow "Sidebar Picker Workflow" via the CLI
    And the GUI is on the pipeline view
    When I create a task with:
      | title    | Sidebar Picker Root Task |
      | workflow | Sidebar Picker Workflow  |
    Then the GUI should show an element with title "1 task(s)" within 10 seconds

  Scenario: Sidebar Traces link opens /traces with the picker rail
    When I click on the element with test id "sidebar-nav-traces"
    Then the URL should contain "/traces"
    And the GUI should show an element with test id "traces-picker-rail" within 10 seconds
    And the GUI should show an element with test id "traces-no-task-hint" within 5 seconds
    And the GUI should show an element with test id "task-picker-input" within 5 seconds

  Scenario: Picker input is auto-focused on /traces
    When I click on the element with test id "sidebar-nav-traces"
    Then the GUI should show an element with test id "task-picker-input" within 10 seconds
    And the focused element has test id "task-picker-input"

  Scenario: Searching and selecting a task in the picker navigates to /traces/:taskId
    When I click on the element with test id "sidebar-nav-traces"
    Then the GUI should show an element with test id "task-picker-input" within 10 seconds
    When I type "Sidebar Picker Root" into the element with test id "task-picker-input"
    And I click on the element containing text "Sidebar Picker Root Task"
    Then the URL should contain "/traces/"
    And the GUI should show "Σ Runs" within 10 seconds
    And the GUI should show "Sidebar Picker Root Task" within 5 seconds
    And the GUI should show an element with test id "subtree-rail" within 5 seconds
    And the GUI should not show an element with test id "traces-picker-rail" within 5 seconds

  Scenario: Switch button swaps the subtree rail for the picker rail
    When I click on the element with test id "sidebar-nav-traces"
    Then the GUI should show an element with test id "task-picker-input" within 10 seconds
    When I type "Sidebar Picker Root" into the element with test id "task-picker-input"
    And I click on the element containing text "Sidebar Picker Root Task"
    Then the GUI should show "Σ Runs" within 10 seconds
    And the GUI should show an element with test id "subtree-rail" within 5 seconds
    When I click on the element with test id "subtree-rail-switch-task"
    Then the GUI should show an element with test id "traces-picker-rail" within 5 seconds
    And the GUI should show an element with test id "task-picker-input" within 5 seconds
    And the GUI should not show an element with test id "subtree-rail" within 5 seconds
