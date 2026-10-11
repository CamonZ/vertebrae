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
