@route_sessions
Feature: Route decisions choose how an llm_inference step enters a conversation
  A route rule's session directive, authored with vtb step update
  --route-config, decides whether its destination starts a new provider
  conversation or resumes one. Entering a step without a directive starts a
  new conversation, so every llm_inference execution records a native
  session id that a later decision can resume.

  Scenario: Claude resumes the conversation a looping route returns to
    Given a configured daemon test environment
    And a session workflow on the "claude" harness
    And the route sends "again" to "work" with session '{"mode":"resume"}'
    And a task assigned to the workflow
    When the work step answers "again" then "done"
    And I start a TaskRun
    And I wait for 2 work executions to reach status "completed"
    Then the first work execution started a new conversation
    And the second work execution resumed the first conversation

  Scenario: Claude starts a fresh conversation for a new directive
    Given a configured daemon test environment
    And a session workflow on the "claude" harness
    And the route sends "again" to "work" with session '{"mode":"new"}'
    And a task assigned to the workflow
    When the work step answers "again" then "done"
    And I start a TaskRun
    And I wait for 2 work executions to reach status "completed"
    Then the first work execution started a new conversation
    And the second work execution started another new conversation

  Scenario: Codex resumes the thread a looping route returns to
    Given a configured daemon test environment
    And a session workflow on the "codex" harness
    And the route sends "again" to "work" with session '{"mode":"resume"}'
    And a task assigned to the workflow
    When the work step answers "again" then "done"
    And I start a TaskRun
    And I wait for 2 work executions to reach status "completed"
    Then the first work execution started a new conversation
    And the second work execution resumed the first conversation

  Scenario: Resuming a step with no completed execution fails at dispatch
    Given a configured daemon test environment
    And a session workflow on the "claude" harness
    And the route sends "again" to "review" with session '{"mode":"resume"}'
    And a task assigned to the workflow
    When the work step answers "again" then "done"
    And I start a TaskRun
    And I wait for the TaskRun to reach status "failed" with outcome "dispatch_failed"
    Then the first work execution started a new conversation
    And the review step was never dispatched and the provider ran once
    And the TaskRun failure names the review step

  Scenario: Claude rejects resuming a conversation it no longer has
    Given a configured daemon test environment
    And a session workflow on the "claude" harness
    And the route sends "again" to "work" with session '{"mode":"resume"}'
    And a task assigned to the workflow
    When the work step answers "again" and its conversation is lost, then "done"
    And I start a TaskRun
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the later work executions failed with "No conversation found with session ID" without a new conversation

  Scenario: Codex rejects resuming a thread without a rollout
    Given a configured daemon test environment
    And a session workflow on the "codex" harness
    And the route sends "again" to "work" with session '{"mode":"resume"}'
    And a task assigned to the workflow
    When the work step answers "again" and its conversation is lost, then "done"
    And I start a TaskRun
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the later work executions failed with "no rollout found for thread id" without a new conversation
