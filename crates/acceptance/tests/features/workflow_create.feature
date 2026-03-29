Feature: Workflow creation with kanban column
  Create workflows with optional kanban_column field.

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
