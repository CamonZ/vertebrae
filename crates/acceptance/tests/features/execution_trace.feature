Feature: CLI execution list inspection
  Execution list should use explicit task and TaskRun modes with compact output.

  Background:
    Given a configured Sacrum client

  Scenario: Task and TaskRun modes list compact TaskRun-backed executions
    Given a workflow "cli-execution-list-wf" with steps "start, finish"
    And I create a task with:
      | title | CLI execution list |
    And I assign the workflow to the task
    When I run vtb "start-taskrun <TASK_ID>"
    Then the command should succeed
    When I store the latest TaskRun ID as "TRACE_RUN_ID"
    And I store the latest TaskRun short ID as "TRACE_RUN_SHORT_ID"
    And I store the task short ID as "TASK_SHORT"
    And I run vtb "execution list <TASK_SHORT>"
    Then the command should succeed
    And the output should contain "TaskRun Executions for task <TASK_ID>"
    And the output should contain "TaskRun: <TRACE_RUN_ID>"
    And the output should contain "taskRunId=<TRACE_RUN_ID>"
    And the output should not contain "TaskRun Trace"
    And the output should not contain "Run Tree"
    And the output should not contain "Session Logs"
    And the output should not contain "rootTaskRunId"
    When I run vtb "execution list --task-run <TRACE_RUN_ID>"
    Then the command should succeed
    And the output should contain "TaskRun Executions for TaskRun <TRACE_RUN_ID>"
    And the output should contain "TaskRun: <TRACE_RUN_ID>"
    And the output should contain "taskRunId=<TRACE_RUN_ID>"
    And the output should not contain "TaskRun Trace"
    And the output should not contain "Run Tree"
    And the output should not contain "Session Logs"
    And the output should not contain "rootTaskRunId"
    When I run vtb "execution list --task-run <TRACE_RUN_SHORT_ID>"
    Then the command should fail with "TaskRun short IDs are not supported"

  Scenario: Historical StepExecutions without TaskRun IDs are not listed
    Given a workflow "cli-no-legacy-execution-list-wf" with steps "inspect, finish"
    And I create a task with:
      | title | CLI no legacy execution list |
    And I assign the workflow to the task
    When I run vtb "execution create <TASK_ID>"
    Then the command should succeed
    When I run vtb "execution list <TASK_ID>"
    Then the command should succeed
    And the output should contain "No TaskRun-backed executions found for task <TASK_ID>"
    And the output should not contain "Legacy Step Executions"
    And the output should not contain "taskRunId=legacy"
