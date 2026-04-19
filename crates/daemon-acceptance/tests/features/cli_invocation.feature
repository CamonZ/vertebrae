Feature: Daemon translates step config into Claude CLI invocation
  The daemon assembles an argv and working directory from the step's
  agent_config, skills, prompt, and the task's worktree. Scenarios here
  assert on the captured invocation rather than the resulting output.

  Scenario: Explicit agent_config.model reaches the CLI
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    And the step is configured with agent_config '{"model":"my-custom-model"}'
    When the mock is scripted to succeed with full metrics
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the mock argv contains "--model" followed by "my-custom-model"

  Scenario: permission_mode plan is passed through and not overridden
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    And the step is configured with agent_config '{"permission_mode":"plan"}'
    When the mock is scripted to succeed with full metrics
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the mock argv contains "--permission-mode" followed by "plan"
    And the mock argv contains "bypassPermissions" exactly 0 times

  Scenario: Worktree path is used as the CLI working directory
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    And the task has worktree "/tmp"
    When the mock is scripted to succeed with full metrics
    And run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the mock working directory is "/tmp"

  Scenario: Empty prompt falls back to "Execute step"
    Given a configured daemon test environment
    And a workflow with one execute step
    And a task assigned to the workflow
    When run_step is invoked
    And I wait for the execution to reach status "completed"
    Then the mock argv contains "-p" followed by "Execute step"
