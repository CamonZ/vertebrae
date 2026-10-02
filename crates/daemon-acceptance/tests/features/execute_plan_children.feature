@execute
Feature: Rhai plan children created once per key
  The documented plan-children sample (docs/agent-context/workflows/steps/
  execute/host-writes.md) runs on PARENT with the documented plan attached as
  its plan artifact. It creates one child per plan item, tagged plan:<key>,
  and finds the children it already made on a rerun.

  Background:
    Given a configured daemon test environment

  Scenario: a rerun finds every child and creates none
    Given a parent with the documented plan
    And the documented plan-children step twice in a row on the parent
    When I start a TaskRun
    And I wait for the second plan run to complete
    Then the parent has exactly one child per plan key:
      | key | title         |
      | api | Build the API |
      | ui  | Build the UI  |
    And the first run created them in plan order and the second found them

  Scenario: retries after a failure that follows the creates converge
    Given a parent with the documented plan and an item titled " "
    And the documented plan-children step on the parent
    When I start a TaskRun
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the plan step failed in at least 2 attempts with a "invalid" error from "vtb::tasks::create"
    And the parent has exactly one child per plan key:
      | key | title         |
      | api | Build the API |
      | ui  | Build the UI  |
