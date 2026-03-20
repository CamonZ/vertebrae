Feature: Task state management
  Archive/unarchive tasks, toggle review flags, and query actionable items.

  Background:
    Given a configured Sacrum client

  # --- archive / unarchive ---

  @cleanup
  Scenario: Archive a task
    Given I create a task titled "To archive"
    And I store the task ID as "task_id"
    When I archive the task
    Then the output should match "Task <task_id> archived"

  @cleanup
  Scenario: Archived task is hidden from default list
    Given I create a task titled "Visible"
    And I store the task ID as "visible_id"
    And I create a task titled "Hidden"
    And I store the task ID as "hidden_id"
    And I archive task "<hidden_id>"
    When I list all tasks
    Then the output should contain "<visible_id>"
    And the output should not contain "<hidden_id>"

  @cleanup
  Scenario: Include-archived shows archived tasks
    Given I create a task titled "Archived task"
    And I store the task ID as "task_id"
    And I archive the task
    When I list tasks with --include-archived
    Then the output should contain "<task_id>"

  @cleanup
  Scenario: Unarchive a task
    Given I create a task titled "To unarchive"
    And I store the task ID as "task_id"
    And I archive the task
    When I unarchive the task
    Then the output should match "Task <task_id> unarchived"
    And the task archived flag should be false

  @cleanup
  Scenario: Double-archive is idempotent
    Given I create a task titled "Double archive"
    And I store the task ID as "task_id"
    When I archive the task
    And I archive the task
    Then the output should match "Task <task_id> archived"
    And the task archived flag should be true

  Scenario: Archive non-existent task fails
    When I attempt to archive task "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "Task not found:"

  # --- review ---

  @cleanup
  Scenario: Toggle review flag on
    Given I create a task titled "Review toggle"
    When I run review for the task
    Then the output should contain "marked as needing review"
    And the task needs_human_review should be true

  @cleanup
  Scenario: Toggle review flag off
    Given I create a task titled "Review toggle" with needs-review
    When I run review for the task
    Then the output should contain "marked as not needing review"
    And the task needs_human_review should be false

  @cleanup
  Scenario: Set review flag explicitly
    Given I create a task titled "Review set"
    When I run review for the task with --set true
    Then the output should contain "marked as needing review"
    And the task needs_human_review should be true
    When I run review for the task with --set false
    Then the output should contain "marked as not needing review"
    And the task needs_human_review should be false

  Scenario: Review non-existent task fails
    When I attempt to run review for task "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "Task not found:"

  # --- ready ---

  @cleanup
  Scenario: Ready shows unblocked tasks
    Given I create a task titled "Ready task"
    And I store the task ID as "task_id"
    When I run ready
    Then the output should contain "Ready to start (backlog):"
    And the output should contain "<task_id>"

  @cleanup
  Scenario: Ready excludes archived tasks
    Given I create a task titled "Active"
    And I store the task ID as "active_id"
    And I create a task titled "Archived"
    And I store the task ID as "archived_id"
    And I archive task "<archived_id>"
    When I run ready
    Then the output should contain "<active_id>"
    And the output should not contain "<archived_id>"

  @cleanup
  Scenario: Ready excludes blocked tasks
    Given I create a task titled "Blocker"
    And I store the task ID as "blocker_id"
    And I create a task titled "Blocked"
    And I store the task ID as "blocked_id"
    And I run depend "<blocked_id>" --on "<blocker_id>"
    When I run ready
    Then the output should contain "<blocker_id>"
    And the output should not contain "<blocked_id>"

  Scenario: Ready with nothing actionable
    When I run ready
    Then the output should match "No actionable items found."
