Feature: Real-time workflow rendering on pipeline view
  When a workflow is created via the CLI, it should appear in the
  pipeline view in real-time without requiring a page reload.

  Scenario: Workflow created via CLI appears in pipeline view
    Given the GUI is on the pipeline view
    When I create a workflow "Pipeline Workflow Test" via the CLI
    Then the GUI should show "Pipeline Workflow Test" within 10 seconds

  Scenario: Workflow final toggle updates and renders on the pipeline view
    Given I create a workflow with:
      | name | Pipeline Final Toggle |
    And the GUI is on the pipeline view
    Then the GUI should show "Pipeline Final Toggle" within 5 seconds
    When I click on the element containing text "Pipeline Final Toggle"
    Then the workflow final toggle should be disabled within 5 seconds
    When I toggle the workflow final setting
    Then the workflow final toggle should be enabled within 10 seconds
    And the pipeline workflow "Pipeline Final Toggle" should show the final badge within 10 seconds
    When the GUI is on the pipeline view
    And I click on the element containing text "Pipeline Final Toggle"
    Then the workflow final toggle should be enabled within 10 seconds
    And the pipeline workflow "Pipeline Final Toggle" should show the final badge within 10 seconds
