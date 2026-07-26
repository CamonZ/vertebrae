Feature: Step lifecycle
  Transition tasks through workflow steps: start, complete, reject, and transition-to.

  Background:
    Given a configured Sacrum client
    And a workflow "test-wf" with steps "backlog, in_progress, pending_review, done:finish"
    And I create a task with:
      | title | Lifecycle task |
    And I assign the workflow to the task

  # --- transition-to ---

  Scenario: Transition to valid next step shows from and to
    When I transition the task to step "in_progress"
    Then the output should contain "Transitioned task"
    And the output should contain "from test-wf:backlog"
    And the output should contain "to test-wf:in_progress"

  Scenario: Transition to same step is allowed
    When I transition the task to step "backlog"
    Then the command should succeed

  Scenario: Sequential transitions through workflow
    When I transition the task to step "in_progress"
    And I transition the task to step "pending_review"
    Then the output should contain "Transitioned task"
    And the output should contain "from test-wf:in_progress"
    And the output should contain "to test-wf:pending_review"

  Scenario: Transition with --skip-validation bypasses graph
    When I transition the task to step "done" with --skip-validation
    Then the output should contain "validation skipped"
    And the output should contain "--skip-validation"

  Scenario: Invalid transition is rejected with valid alternatives
    When I transition the task to step "done"
    Then the command should fail with "Invalid step transition from"
    And the error should contain "Valid transitions from"
    And the error should contain "backlog"

  Scenario: Target step from different workflow is rejected
    Given a second workflow "other-wf" with steps "alpha, beta"
    When I transition the task to step "alpha" of "other-wf"
    Then the command should fail with "Target step belongs to workflow"
    And the error should contain "Use 'vtb workflow assign' to change workflows first"

  Scenario: Transition to final step makes dependents ready
    Given I create a task with:
      | title | Dependent task |
    And I store the task ID as "dependent_id"
    And I run depend "<dependent_id>" --on the lifecycle task
    When I transition the lifecycle task through to step "done" with --skip-validation
    And I run ready
    Then the output should contain "Ready to start (backlog):"
    And the output should contain "<dependent_id>"
    And the output should contain "Dependent task"

  Scenario: Transition to non-existent step name fails
    When I transition the task to step "nonexistent_step_name"
    Then the command should fail with "not found"

  Scenario: Transition to non-existent step UUID fails
    When I transition the task to step "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "not found"
