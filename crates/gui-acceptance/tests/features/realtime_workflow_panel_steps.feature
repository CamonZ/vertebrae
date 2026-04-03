Feature: Real-time workflow detail panel step updates
  When steps are created or deleted via the CLI, the open workflow detail panel
  should reflect the changes in real-time without requiring a page reload.

  Scenario: Step created via CLI appears in workflow detail panel
    Given I create a workflow with:
      | name | Workflow Steps Panel |
    And the GUI is on the pipeline view
    Then the GUI should show "Workflow Steps Panel" within 5 seconds
    When I click on the element containing text "Workflow Steps Panel"
    Then the GUI should show "Workflow Details" within 5 seconds
    When I create a step "New Panel Step" in the workflow "Workflow Steps Panel" via the CLI
    Then the GUI should show "New Panel Step" within 10 seconds

  Scenario: Step deleted via CLI disappears from workflow detail panel
    Given I create a workflow with:
      | name | Workflow Delete Panel |
    And I create a step "Step To Delete" in the workflow "Workflow Delete Panel" via the CLI
    And the GUI is on the pipeline view
    Then the GUI should show "Step To Delete" within 5 seconds
    When I click on the element containing text "Workflow Delete Panel"
    Then the GUI should show "Workflow Details" within 5 seconds
    And the GUI should show "Step To Delete" within 5 seconds
    When I delete the step via the CLI
    Then the GUI should not show "Step To Delete" within 10 seconds
