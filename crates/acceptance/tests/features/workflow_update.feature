Feature: Workflow update with optional fields
  Update workflow is_default and factory_name via the supported CLI options.

  Background:
    Given a configured Sacrum client

  Scenario: Update a non-default workflow to be the default
    Given I create a workflow "Promotable WF" with:
      | description | Will become default |
    Then the command should succeed
    And the workflow is_default should be false
    When I update the workflow with --default
    Then the command should succeed
    And the workflow is_default should be true

  Scenario: Update a default workflow to no longer be the default
    Given I create a workflow "Demotable WF" with:
      | default | true |
    Then the command should succeed
    And the workflow is_default should be true
    When I update the workflow with --no-default
    Then the command should succeed
    And the workflow is_default should be false

  Scenario: Set and clear a workflow factory name
    Given I create a workflow "Factory Update WF" with:
      | factory_name | Initial Factory |
    Then the command should succeed
    And the workflow factory_name should be "Initial Factory"
    When I update the workflow with --factory-name "Updated Factory"
    Then the command should succeed
    And the workflow factory_name should be "Updated Factory"
    When I update the workflow with --factory-name ""
    Then the command should succeed
    And the workflow factory_name should be empty
