@workflow_import
Feature: Workflow bundle import
  Import Sacrum-format workflow bundles through preflight and one bulk mutation.

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

  @workflow_round_trip
  Scenario: Rich workflow graph including an execute step and route, edge, inter_workflow and wait_children session directives survives export, import, and re-export
    When I clear the acceptance project's existing workflows
    And I stage the built-in workflow bundle fixture
    And I import the staged workflow bundle
    Then the command should succeed
    And the workflow import JSON status should be "committed"
    When I export all workflows to the source bundle file
    Then the command should succeed
    When I switch the acceptance client to a fresh project
    And I import the source workflow bundle
    Then the command should succeed
    And the workflow import JSON status should be "committed"
    When I export all workflows to the destination bundle file
    Then the command should succeed
    And the roundtrip bundles should preserve the authored execute step
    And the roundtrip bundles should preserve the route session directive
    And the roundtrip bundles should preserve the edge session directive
    And the roundtrip bundles should preserve the cross-run session directives
    And the source and destination workflow bundles should have matching canonical semantics
    And the destination workflow graph should match the import mappings

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

  Scenario Outline: Bundle validation rejects non-portable cross-run session steps
    When I stage the built-in workflow bundle fixture with the <surface> session '<session>'
    And I import the staged workflow bundle with --dry-run
    Then the command should fail
    And the error should contain "<path>"

    Examples:
      | surface        | session                                | path                                |
      | inter_workflow | {"mode":"resume","step_id":"uuid"}     | config.route_config.rules[1].session.step_id  |
      | inter_workflow | {"mode":"resume","step_ref":"review"}  | config.route_config.rules[1].session.step_ref |
      | wait_children  | {"mode":"fork","step_id":"uuid"}       | config.session.step_id              |
      | wait_children  | {"mode":"fork","step_ref":"review"}    | config.session.step_ref             |

  Scenario: Malformed bundles fail before the backend mutation
    When I stage a malformed workflow bundle
    And I import the staged workflow bundle
    Then the command should fail
    And the error should contain "invalid workflow bundle"
