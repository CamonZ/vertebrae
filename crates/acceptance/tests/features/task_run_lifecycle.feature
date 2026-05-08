Feature: CLI TaskRun lifecycle
  Run, stop, list, and show should use TaskRun lifecycle data for automation state.

  Background:
    Given a configured Sacrum client

  Scenario: TaskRun lifecycle state is visible across CLI commands
    Given a workflow "cli-taskrun-wf" with steps "start, finish"
    And I create a task with:
      | title | CLI TaskRun lifecycle |
    And I assign the workflow to the task
    When I run vtb "start-taskrun <TASK_ID>"
    Then the command should succeed
    And the output should match "Run: (queued|executing|waiting) taskRun=[0-9a-f-]{36} latestStep=([0-9a-f-]{36}|none)"
    When I list tasks
    Then the output should contain "Run"
    And the output should match "<TASK_ID>\\s+task\\s+[^\\n]+\\s+(queued|executing|waiting)"
    When I show the task
    Then the output should match "Run: (queued|executing|waiting) taskRun=[0-9a-f-]{36} latestStep=([0-9a-f-]{36}|none)"
    And the output should contain "Controls:"
    And the output should contain "History:"
    When I run vtb "stop-taskrun <TASK_ID>"
    Then the command should succeed
    And the output should match "Stopped run: (stopping|stopped|queued|executing|waiting) taskRun=[0-9a-f-]{36} latestStep=([0-9a-f-]{36}|none)"
