Feature: Traces sidebar entry and task picker
  The Sidebar exposes a Traces nav item that opens /traces. With no task
  selected, the page renders the same full layout as /traces/:taskId
  with a task picker rail in place of the subtree. Selecting a task in
  the picker navigates to /traces/:taskId.

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
    And the GUI should show an element with test id "traces-hero-runs" within 10 seconds
    And the GUI should show "Sidebar Picker Root Task" within 5 seconds
    And the GUI should not show an element with test id "traces-picker-rail" within 5 seconds

  Scenario: Searching traces picker by description filters the left pane
    When I create a task with:
      | title       | Traces Picker Description Search Target |
      | description | traces picker description needle         |
    And I create a task with:
      | title       | Traces Picker Description Search Miss |
      | description | Unrelated traces picker description   |
    And I click on the element with test id "sidebar-nav-traces"
    Then the GUI should show an element with test id "task-picker-input" within 10 seconds
    When I type "traces picker description needle" into the element with test id "task-picker-input"
    Then the GUI should show "Traces Picker Description Search Target" within 10 seconds
    And the GUI should not show "Traces Picker Description Search Miss" within 10 seconds

  Scenario: Searching traces picker by full UUID filters the left pane
    When I create a task with:
      | title | Traces Picker Full UUID Search Miss |
    And I create a task with:
      | title | Traces Picker Full UUID Search Target |
    And I click on the element with test id "sidebar-nav-traces"
    Then the GUI should show an element with test id "task-picker-input" within 10 seconds
    When I type the current task ID into the element with test id "task-picker-input"
    Then the GUI should show "Traces Picker Full UUID Search Target" within 10 seconds
    And the GUI should not show "Traces Picker Full UUID Search Miss" within 10 seconds

  Scenario: Searching traces picker by UUID prefix filters the left pane
    When I create a task with:
      | title | Traces Picker UUID Prefix Search Miss |
    And I create a task with:
      | title | Traces Picker UUID Prefix Search Target |
    And I click on the element with test id "sidebar-nav-traces"
    Then the GUI should show an element with test id "task-picker-input" within 10 seconds
    When I type the current task short ID into the element with test id "task-picker-input"
    Then the GUI should show "Traces Picker UUID Prefix Search Target" within 10 seconds
    And the GUI should not show "Traces Picker UUID Prefix Search Miss" within 10 seconds
