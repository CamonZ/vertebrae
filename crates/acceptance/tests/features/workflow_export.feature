Feature: Workflow bundle export
  Export complete portable workflow graphs as deterministic JSON.

  Background:
    Given a configured Sacrum client

  Scenario: Export all workflows from an empty project
    When I run vtb "workflow export --all"
    Then the command should succeed
    And the workflow export stdout should be a valid versioned bundle

  Scenario: Workflow export requires an explicit selection
    When I run vtb "workflow export"
    Then the command should fail
    And the error should contain "exactly one workflow export selection"

  Scenario: Export one workflow to stdout as a portable bundle
    Given I create a workflow "Exportable WF" with:
      | description | Portable graph |
      | steps | first, second |
    Then the command should succeed
    When I run vtb "workflow export --workflow <workflow_id>"
    Then the command should succeed
    And the workflow export stdout should be a valid versioned bundle
    And the workflow export stdout should not contain persistence fields

  Scenario: Export all workflows and preserve exact file bytes
    Given I create a workflow "First Export WF" with:
      | steps | first, second |
    Then the command should succeed
    When I remember the workflow export stdout for "<workflow_id>"
    Then the command should succeed
    When I run vtb "workflow export --workflow <workflow_id>"
    Then the command should succeed
    And the workflow export stdout should equal the remembered stdout
    When I export the workflow to a file
    Then the command should succeed
    And the workflow export file should equal the remembered stdout
    When I run vtb "workflow export --all"
    Then the command should succeed
    And the workflow export stdout should be a valid versioned bundle

  Scenario: Single workflow selection rejects an outgoing destination outside the bundle
    Given I create a workflow "Source Export WF" with:
      | steps | source |
    Then the command should succeed
    And a second workflow "Destination Export WF" with steps "destination"
    When I run vtb "workflow transition add <workflow_id> <second_workflow_id> --label handoff"
    Then the command should succeed
    When I run vtb "workflow export --workflow <workflow_id>"
    Then the command should fail
    And the error should contain "missing destination"
    And the error should contain "--all"

  Scenario: Workflow export selection flags cannot be combined
    Given I create a workflow "Selection Export WF" with:
      | steps | only |
    Then the command should succeed
    When I run vtb "workflow export --workflow <workflow_id> --all"
    Then the command should fail
    And the error should contain "cannot be used with"
