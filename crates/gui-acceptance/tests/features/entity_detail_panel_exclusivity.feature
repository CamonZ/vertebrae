Feature: Exclusive entity detail panels
  Chat entity links replace the selected task, workflow, or step detail panel
  while leaving the local chat and an attached artifact preview available.

  Scenario: A task link from chat replaces the selected task panel
    Given the GUI is showing the task list
    When I create a task "Chat task target" via the CLI
    And I configure the mock local chat reply with a link to the current task
    And I create a task "Existing task panel" via the CLI
    Then the GUI should show "Existing task panel" within 10 seconds
    When I click on the element containing text "Existing task panel"
    And I create a task artifact "selected-task-artifact.md" of kind "markdown" via the CLI
    Then the GUI should show "selected-task-artifact.md" within 10 seconds
    When I click on the element containing text "selected-task-artifact.md"
    Then the GUI should show an element with test id "artifact-inspector-panel" within 5 seconds
    And the GUI should show exactly 1 elements with test id "task-detail-panel" within 5 seconds
    And I click on the element with test id "local-chat-launcher"
    Then the GUI should show "New Chat" within 5 seconds
    And the GUI should show exactly 1 elements with test id "task-detail-panel" within 5 seconds
    And the GUI should show exactly 1 elements with test id "artifact-inspector-panel" within 5 seconds
    And I type "open the linked task" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show "the linked task" within 10 seconds
    When I click on the element with test id "vtb-entity-link"
    Then the GUI should show "Chat task target" within 10 seconds
    And the GUI should show exactly 1 elements with test id "task-detail-panel" within 5 seconds
    And the GUI should not show an element with test id "artifact-inspector-panel" within 5 seconds

  Scenario: A task link from chat replaces the selected task panel on the board
    Given the GUI is on the kanban board
    When I create a task "Board chat target" via the CLI
    And I configure the mock local chat reply with a link to the current task
    And I create a task "Existing board task panel" via the CLI
    Then the GUI should show "Existing board task panel" within 10 seconds
    When I click on the element containing text "Existing board task panel"
    And I click on the element with test id "local-chat-launcher"
    And I type "open the linked task" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show "the linked task" within 10 seconds
    When I click on the element with test id "vtb-entity-link"
    Then the GUI should show "Board chat target" within 10 seconds
    And the GUI should show exactly 1 elements with test id "task-detail-panel" within 5 seconds

  Scenario: A workflow link from chat replaces the selected workflow panel
    Given I create a workflow "Chat workflow target" via the CLI
    And I configure the mock local chat reply with a link to the current workflow
    And I create a workflow "Existing workflow panel" via the CLI
    And the GUI is on the pipeline view
    When I click on the element containing text "Existing workflow panel"
    Then the GUI should show "Workflow Details" within 10 seconds
    When I click on the element with test id "local-chat-launcher"
    And I type "open the linked workflow" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show "the linked workflow" within 10 seconds
    When I click on the element with test id "vtb-entity-link"
    Then the GUI should show "Chat workflow target" within 10 seconds
    And the GUI should show exactly 1 elements with test id "global-entity-panel" within 5 seconds

  Scenario: A step link from chat replaces the selected step panel
    Given I create a workflow "Chat step target workflow" via the CLI
    And I create a step "Chat step target" in the workflow "Chat step target workflow" via the CLI
    And I configure the mock local chat reply with a link to the current step
    And I create a workflow "Existing step panel workflow" via the CLI
    And I create a step "Existing step panel" in the workflow "Existing step panel workflow" via the CLI
    And the GUI is on the pipeline view
    When I click on the element with test id "step-node-Existing step panel"
    Then the GUI should show "Existing step panel" within 10 seconds
    When I click on the element with test id "local-chat-launcher"
    And I type "open the linked step" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show "the linked step" within 10 seconds
    When I click on the element with test id "vtb-entity-link"
    Then the GUI should show "Chat step target" within 10 seconds
    And the GUI should show exactly 1 elements with test id "global-entity-panel" within 5 seconds
