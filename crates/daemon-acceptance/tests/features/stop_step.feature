Feature: Stop workflow step run boundaries
  A stop step ends the current TaskRun without dispatching work to the daemon.
  The task remains incomplete, and a later TaskRun bypasses the stop through
  its single continuation.

  Scenario: Stop boundary is not dispatched and the next run completes
    Given a configured daemon test environment
    And a workflow with a stop step and a finish continuation
    And a task assigned to the workflow
    When I start a TaskRun for the task
    And I wait for the TaskRun to reach status "stopped" with outcome "run_boundary"
    Then the stop boundary was never dispatched to the daemon
    And the task is still incomplete
    When I start a TaskRun for the task
    And I wait for the TaskRun to reach status "completed"
    Then the task is complete
