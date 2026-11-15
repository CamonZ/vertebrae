Feature: CLI TaskRun lifecycle
  Run, stop, list, and show should use TaskRun lifecycle data for automation state.

  Background:
    Given a configured Sacrum client

  Scenario: TaskRun lifecycle state is visible across CLI commands
    Given a workflow "cli-taskrun-wf" with steps "start:human_input, finish:finish"
    And the human_input step "start" is configured with role "Review lifecycle" and question "Finish this run?", artifact "approval", and the approval output schema
    And I create a task with:
      | title | CLI TaskRun lifecycle |
    And I assign the workflow to the task
    When I run vtb "start-taskrun <TASK_ID>"
    Then the command should succeed
    And the output should match "Run: (queued|executing|waiting) taskRun=[0-9a-f-]{36} maxConcurrency=(null|[0-9]+) latestStep=([0-9a-f-]{36}|none)"
    When I store the latest TaskRun ID as "task_run_id"
    And the TaskRun "task_run_id" is waiting at the human_input gate
    When I list tasks
    Then the output should contain "Run"
    And the output should match "<TASK_ID> +task +[^ ]+ +waiting"
    When I show the task
    Then the output should match "Run: waiting taskRun=<task_run_id> maxConcurrency=(null|[0-9]+) latestStep=[0-9a-f-]{36}"
    And the output should contain "Controls:"
    And the output should contain "History:"
    When I run vtb "stop-taskrun <TASK_ID>"
    Then the command should succeed
    And the output should match "Stopped run: (stopping|stopped|queued|executing|waiting) taskRun=[0-9a-f-]{36} maxConcurrency=(null|[0-9]+) latestStep=([0-9a-f-]{36}|none)"
    And the TaskRun "task_run_id" should reach status "stopped"
