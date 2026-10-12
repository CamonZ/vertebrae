@transition_sessions
Feature: Step transitions choose how an llm_inference step enters a conversation
  A step transition's session directive, authored with vtb step update
  --transition-session, lets consecutive llm_inference steps continue one
  provider conversation without a route step between them.

  Scenario: Claude resumes the previous step's conversation over a linear edge
    Given a configured daemon test environment
    And a linear session workflow on the "claude" harness whose draft -> revise edge carries "resume:draft"
    And a task assigned to the workflow
    When the draft and revise steps each answer "done"
    And I start a TaskRun
    And I wait for the TaskRun to reach status "completed"
    Then the revise execution resumed the draft conversation

  Scenario: Codex resumes the previous step's thread over a linear edge
    Given a configured daemon test environment
    And a linear session workflow on the "codex" harness whose draft -> revise edge carries "resume:draft"
    And a task assigned to the workflow
    When the draft and revise steps each answer "done"
    And I start a TaskRun
    And I wait for the TaskRun to reach status "completed"
    Then the revise execution resumed the draft conversation

  Scenario: Claude resumes the pre-boundary conversation after a stop step is bypassed
    Given a configured daemon test environment
    And a stop-boundary session workflow on the "claude" harness whose pause -> revise edge carries "resume:draft"
    And a task assigned to the workflow
    When I start a TaskRun for the task
    And I wait for the TaskRun to reach status "stopped" with outcome "run_boundary"
    And I start a TaskRun for the task
    And I wait for the TaskRun to reach status "completed"
    Then the revise execution resumed the draft conversation of the stopped run

  Scenario: Codex resumes the pre-boundary thread after a stop step is bypassed
    Given a configured daemon test environment
    And a stop-boundary session workflow on the "codex" harness whose pause -> revise edge carries "resume:draft"
    And a task assigned to the workflow
    When I start a TaskRun for the task
    And I wait for the TaskRun to reach status "stopped" with outcome "run_boundary"
    And I start a TaskRun for the task
    And I wait for the TaskRun to reach status "completed"
    Then the revise execution resumed the draft conversation of the stopped run

  # Sacrum logs session_not_found; the TaskRun records only the source step
  # it found no turn for, so that is what the scenario asserts.
  Scenario: Resuming past a stop step with no prior turn fails the run at dispatch naming the source step
    Given a configured daemon test environment
    And a stop-boundary session workflow on the "claude" harness whose pause -> revise edge carries "resume:revise"
    And a task assigned to the workflow
    When I start a TaskRun for the task
    And I wait for the TaskRun to reach status "stopped" with outcome "run_boundary"
    And I start a TaskRun for the task
    And I wait for the TaskRun to reach status "failed" with outcome "dispatch_failed"
    Then the TaskRun failed at dispatch naming the revise step and the provider ran once
