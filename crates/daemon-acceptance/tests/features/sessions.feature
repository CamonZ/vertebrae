@sessions
Feature: Named llm_inference sessions
  Steps authored with vtb step add --session-name/--session-mode start or
  resume one provider conversation within a TaskRun. Sacrum resolves the
  name at dispatch; the daemon launches the harness to start or resume it and
  records the provider's native session id on the execution.

  Scenario: Claude steps start and then resume one conversation
    Given a configured daemon test environment
    And a "claude" workflow whose session steps use modes "new, resume"
    And a task assigned to the workflow
    When the "claude" session steps are scripted to succeed
    And I start a TaskRun for the task
    And I wait for the TaskRun to reach status "completed"
    Then the Claude session steps started and then resumed one conversation

  Scenario: Codex steps start and then resume one thread
    Given a configured daemon test environment
    And a "codex" workflow whose session steps use modes "new, resume"
    And a task assigned to the workflow
    When the "codex" session steps are scripted to succeed
    And I start a TaskRun for the task
    And I wait for the TaskRun to reach status "completed"
    Then the Codex session steps started and then resumed one thread

  Scenario: Resume without a binding fails at dispatch without launching the provider
    Given a configured daemon test environment
    And a "claude" workflow whose session steps use modes "resume"
    And a task assigned to the workflow
    When the "claude" session steps are scripted to succeed
    And I start a TaskRun for the task
    And I wait for the TaskRun to reach status "failed" with outcome "dispatch_failed"
    Then no provider was launched
    And the TaskRun outcome reason is "conv"

  Scenario: Resume-or-new without a binding starts a new conversation
    Given a configured daemon test environment
    And a "claude" workflow whose session steps use modes "resume_or_new"
    And a task assigned to the workflow
    When the "claude" session steps are scripted to succeed
    And I start a TaskRun for the task
    And I wait for the TaskRun to reach status "completed"
    Then the Claude session step started a new conversation

  Scenario: Claude rejects a resume of a lost conversation
    Given a configured daemon test environment
    And a "claude" workflow whose session steps use modes "new, resume"
    And a task assigned to the workflow
    When the "claude" provider loses the conversation after the first session step
    And I start a TaskRun for the task
    And I wait for session step "second" to reach status "failed"
    Then the Claude resume failed with "No conversation found with session ID" without starting a new conversation

  Scenario: Codex rejects a resume of a lost thread
    Given a configured daemon test environment
    And a "codex" workflow whose session steps use modes "new, resume"
    And a task assigned to the workflow
    When the "codex" provider loses the conversation after the first session step
    And I start a TaskRun for the task
    And I wait for session step "second" to reach status "failed"
    Then the Codex resume failed with "no rollout found for thread id" without starting a new thread

  Scenario: Steps without a session launch providers as before
    Given a configured daemon test environment
    And a workflow with one inference step
    And a task assigned to the workflow
    When the mock is scripted to succeed with full metrics
    And I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the Claude mock was launched one-shot without session flags
    And the execution records no native session id
