@execute
Feature: Rhai child-outcome rollup
  The documented children-summary sample (docs/agent-context/workflows/steps/
  execute/host-reads.md) runs on PARENT. It reads each direct child's outcome
  artifact, and output persistence stores the summary on PARENT as
  children-summary.json. A child's outcome cell is the artifact body; "-"
  means the child has no outcome. Children are titled rollup-<role>.

  Background:
    Given a configured daemon test environment
    And a parent whose children report outcomes:
      | child  | outcome                           |
      | PASSED | {"status": "passed", "tests": 12} |
      | FAILED | {"status": "failed", "tests": 3}  |
      | NULL   | null                              |
      | SILENT | -                                 |
    And PASSED has a child with its own outcome

  Scenario: the summary lists reported and missing children and is persisted on the parent
    Given the documented children-summary step on the parent
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the children summary, in ID order, is:
      | child  | outcome                           |
      | PASSED | {"status": "passed", "tests": 12} |
      | FAILED | {"status": "failed", "tests": 3}  |
      | NULL   | missing                           |
      | SILENT | missing                           |
    And the parent's children-summary artifact holds the same summary

  Scenario: rerunning the step produces the same summary and replaces the artifact
    Given the documented children-summary step twice in a row on the parent
    When I start a TaskRun
    And I wait for the second summary to complete
    Then both summary runs returned the same summary
    And the children summary, in ID order, is:
      | child  | outcome                           |
      | PASSED | {"status": "passed", "tests": 12} |
      | FAILED | {"status": "failed", "tests": 3}  |
      | NULL   | missing                           |
      | SILENT | missing                           |
    And the parent's children-summary artifact holds the same summary
    And the task has exactly 1 artifact named "children-summary"

  Scenario: a malformed child outcome fails the step and persists nothing
    Given the documented children-summary step on the parent
    And a child of the parent whose outcome is malformed JSON
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the execution failed with a "invalid" error from "vtb::artifacts::read_json"
    And the task has no artifact named "children-summary"
