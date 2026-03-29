Feature: Workflow creation with kanban column and default flag
  Create workflows with optional kanban_column and default fields.

  Background:
    Given a configured Sacrum client

  Scenario: Create workflow with kanban column
    When I create a workflow "Kanban WF" with:
      | kanban_column | In Progress |
    Then the command should succeed
    And the workflow kanban_column should be "In Progress"

  Scenario: Create workflow without kanban column
    When I create a workflow "Plain WF" with:
      | description | A plain workflow |
    Then the command should succeed
    And the workflow kanban_column should be empty

  Scenario: Create workflow with --default flag
    When I create a workflow "Default WF" with:
      | default | true |
    Then the command should succeed
    And the workflow is_default should be true

  Scenario: Create workflow without --default flag
    When I create a workflow "Regular WF" with:
      | description | A regular workflow |
    Then the command should succeed
    And the workflow is_default should be false
