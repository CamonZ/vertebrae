Feature: Workflow update with default flag
  Update workflow is_default via --default and --no-default flags.

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
