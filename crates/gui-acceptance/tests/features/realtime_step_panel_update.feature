Feature: Real-time step detail panel updates
  When a step is modified via the CLI, its open detail panel should reflect
  the changes in real-time without requiring a page reload.

  Scenario: Step name update reflects in open step detail panel
    Given I create a workflow with:
      | name | Step Panel Workflow |
    And I create a step "Original Step Name" in the workflow "Step Panel Workflow" via the CLI
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    Then the GUI should show "Original Step Name" within 5 seconds
    When I click on the element containing text "Original Step Name"
    Then the GUI should show "Step Configuration" within 5 seconds
    When I update the step name to "Updated Step Name" via the CLI
    Then the GUI should show "Updated Step Name" within 10 seconds

  Scenario: Human input step type renders in open step detail panel
    Given I create a workflow with:
      | name | Human Input Step Panel Workflow |
    And I create a step "Approval Gate" with type "human_input" in the workflow "Human Input Step Panel Workflow" via the CLI
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    Then the GUI should show "Approval Gate" within 10 seconds
    When I click on the element with test id "step-node-Approval Gate"
    Then the GUI should show "Step Configuration" within 5 seconds
    And the GUI element with test id "step-type-badge" should have text "human_input" within 5 seconds
