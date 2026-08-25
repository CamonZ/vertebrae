Feature: Workflow factory name in the GUI
  Workflow factory names should be visible and editable in the workflow detail panel.

  Scenario: Factory name appears and can be cleared in the workflow panel
    Given I create a workflow with:
      | name         | Factory GUI Workflow |
      | factory_name | Shared Factory       |
    And the GUI is on the pipeline view
    Then the GUI should show "Factory GUI Workflow" within 5 seconds
    When I click on the element containing text "Factory GUI Workflow"
    Then the GUI should show "Workflow Details" within 5 seconds
    And the GUI element with test id "factory-name-value" should have text "Shared Factory" within 5 seconds
    When I click on the element with test id "factory-name-edit"
    And I click on the element with test id "factory-name-clear"
    And I click on the element with test id "factory-name-save"
    Then the GUI element with test id "factory-name-value" should have text "None" within 10 seconds
