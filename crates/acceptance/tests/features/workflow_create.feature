Feature: Workflow creation with track and kanban column
  Create workflows with optional track and kanban_column fields.

  Background:
    Given a configured Sacrum client

  Scenario: Create workflow with track
    When I create a workflow "Tracked WF" with:
      | track | design |
    Then the command should succeed
    And the workflow track should be "design"
    And the workflow kanban_column should be empty

  Scenario: Create workflow with kanban column
    When I create a workflow "Kanban WF" with:
      | kanban_column | In Progress |
    Then the command should succeed
    And the workflow kanban_column should be "In Progress"
    And the workflow track should be empty

  Scenario: Create workflow with both track and kanban column
    When I create a workflow "Full WF" with:
      | track         | engineering |
      | kanban_column | Review      |
    Then the command should succeed
    And the workflow track should be "engineering"
    And the workflow kanban_column should be "Review"

  Scenario: Create workflow without track or kanban column
    When I create a workflow "Plain WF" with:
      | description | A plain workflow |
    Then the command should succeed
    And the workflow track should be empty
    And the workflow kanban_column should be empty
