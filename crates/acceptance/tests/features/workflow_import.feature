@workflow_import
Feature: Workflow bundle import
  Import versioned workflow bundles through preflight and one bulk mutation.

  Background:
    Given a configured Sacrum client

  Scenario: Dry-run validates a rich bundle without generated IDs
    When I stage the built-in workflow bundle fixture
    And I import the staged workflow bundle with --dry-run
    Then the command should succeed
    And the workflow import JSON status should be "dry-run"
    And the workflow import JSON should contain no generated mappings

  Scenario: Commit imports a rich bundle and reports complete mappings
    When I stage the built-in workflow bundle fixture
    And I import the staged workflow bundle
    Then the command should succeed
    And the workflow import JSON status should be "committed"
    And the workflow import JSON should contain complete mappings

  Scenario: Create-only preflight rejects an existing workflow name
    Given I create a workflow "Conflict WF" with:
      | steps | only |
    Then the command should succeed
    When I export the workflow to a file
    Then the command should succeed
    When I import the exported workflow with --dry-run
    Then the command should fail
    And the error should contain "create-only policy"
    And the error should contain "Conflict WF"

  Scenario: Malformed bundles fail before the backend mutation
    When I stage a malformed workflow bundle
    And I import the staged workflow bundle
    Then the command should fail
    And the error should contain "invalid workflow bundle"
