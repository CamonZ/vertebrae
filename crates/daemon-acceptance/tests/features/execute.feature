@execute
Feature: Rhai JSON transformations
  Execute binds the complete immutable context and persists validated JSON without a provider.

  Scenario Outline: Producer output is transformed and consumed within one TaskRun
    Given a configured daemon test environment
    And a CLI-authored Rhai transform consumer workflow with quantity <quantity>
    And a task assigned to the workflow
    When I start a TaskRun
    And I wait for the Rhai consumer to complete
    Then the Rhai workflow persists total <total> and resolved snapshots in one TaskRun

    Examples:
      | quantity | total |
      | 3        | 36    |
      | 4        | 48    |

  Scenario Outline: Rhai errors fail through the execution completion boundary
    Given a configured daemon test environment
    And a CLI-authored Rhai step returning script "<script>"
    And a task assigned to the workflow
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the Rhai failure attempts have failed status and no completed output

    Examples:
      | script                         |
      | let = ;                        |
      | task.missing * 2              |
      | execution.run_count + true          |
      | #{ name: 123, total: 36 }       |
