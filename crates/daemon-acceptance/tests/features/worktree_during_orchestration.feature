Feature: Worktree updates during orchestration
  A task's worktree can be updated while the daemon is executing a workflow
  step.

  @worktree-during-orchestration
  Scenario: Set worktree while the daemon is working on a step
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When the mock is scripted to sleep 15000 milliseconds
    And I orchestrate the task
    And a separate process sets the task worktree to "/tmp" while the daemon is working on the step
    And I wait for the execution to reach status "completed"
    Then the task worktree should be "/tmp"
    Then the execution status is "completed"
