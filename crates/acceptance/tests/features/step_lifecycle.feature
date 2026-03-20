Feature: Step lifecycle
  Transition tasks through workflow steps: start, complete, reject, and transition-to.

  Background:
    Given a configured Sacrum client
    And a workflow "test-wf" with steps "backlog, in_progress, pending_review, done"
    And I create a task with:
      | title | Lifecycle task |
    And I assign the workflow to the task

  # --- transition-to ---

  Scenario: Transition to valid next step
    When I transition the task to step "in_progress"
    Then the output should contain "Transitioned task"
    And the output should contain "to test-wf:in_progress"

  Scenario: Transition to same step is allowed
    When I transition the task to step "backlog"
    Then the command should succeed

  Scenario: Transition with --skip-validation bypasses graph
    When I transition the task to step "done" with --skip-validation
    Then the output should contain "validation skipped"
    And the output should contain "--skip-validation"

  Scenario: Invalid transition is rejected with valid alternatives
    When I transition the task to step "done"
    Then the command should fail with "Invalid step transition from"
    And the error should contain "Valid transitions from"

  Scenario: Task without workflow cannot transition
    Given I create a task with:
      | title | No workflow task |
    When I transition the task to step "in_progress"
    Then the command should fail with "is not assigned to any workflow"
    And the error should contain "Use 'vtb workflow assign' first"

  Scenario: Target step from different workflow is rejected
    Given a second workflow "other-wf" with steps "alpha, beta"
    When I transition the task to step "alpha" of "other-wf"
    Then the command should fail with "Target step belongs to workflow"
    And the error should contain "Use 'vtb workflow assign' to change workflows first"

  Scenario: Transition to final step shows unblocked tasks
    Given I create a task with:
      | title | Dependent task |
    And I store the task ID as "dependent_id"
    And I run depend "<dependent_id>" --on the lifecycle task
    When I transition the lifecycle task through to step "done" with --skip-validation
    Then the output should contain "Unblocked tasks:"
    And the output should contain "<dependent_id>"

  Scenario: Transition to non-existent step fails
    When I transition the task to step "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "not found"
