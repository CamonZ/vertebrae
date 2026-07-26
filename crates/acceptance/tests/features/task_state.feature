Feature: Task state management
  Archive/unarchive tasks and query actionable items.

  Background:
    Given a configured Sacrum client

  # --- archive / unarchive ---

  Scenario: Archive a task
    Given I create a task with:
      | title | To archive |
    And I store the task ID as "task_id"
    When I archive the task
    Then the output should match "Task <task_id> archived"

  Scenario: Archived task is hidden from default list
    Given I create a task with:
      | title | Visible |
    And I store the task ID as "visible_id"
    And I create a task with:
      | title | Hidden |
    And I store the task ID as "hidden_id"
    And I archive task "<hidden_id>"
    When I list tasks
    Then the output should contain "<visible_id>"
    And the output should not contain "<hidden_id>"

  Scenario: Include-archived shows archived tasks
    Given I create a task with:
      | title | Archived task |
    And I store the task ID as "task_id"
    And I archive the task
    When I list tasks with:
      | include_archived | true |
    Then the output should contain "<task_id>"

  Scenario: Unarchive a task
    Given I create a task with:
      | title | To unarchive |
    And I store the task ID as "task_id"
    And I archive the task
    When I unarchive the task
    Then the output should match "Task <task_id> unarchived"
    And the task archived should be "false"

  Scenario: Double-archive is idempotent
    Given I create a task with:
      | title | Double archive |
    And I store the task ID as "task_id"
    When I archive the task
    And I archive the task
    Then the output should match "Task <task_id> archived"
    And the task archived should be "true"

  Scenario: Archive non-existent task fails
    When I archive task "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "Task not found:"

  # --- ready ---

  Scenario: Ready lists actionable tasks
    Given I create a task with:
      | title | Ready task |
    And I store the task ID as "task_id"
    When I run ready
    Then the output should contain "Ready to start (backlog):"
    And the output should contain "<task_id>"

  Scenario: Ready excludes archived tasks
    Given I create a task with:
      | title | Active |
    And I store the task ID as "active_id"
    And I create a task with:
      | title | Archived |
    And I store the task ID as "archived_id"
    And I archive task "<archived_id>"
    When I run ready
    Then the output should contain "<active_id>"
    And the output should not contain "<archived_id>"

  Scenario: Ready excludes blocked tasks
    Given I create a task with:
      | title | Blocker |
    And I store the task ID as "blocker_id"
    And I create a task with:
      | title | Blocked |
    And I store the task ID as "blocked_id"
    And I run depend "<blocked_id>" --on "<blocker_id>"
    When I run ready
    Then the output should contain "<blocker_id>"
    And the output should not contain "<blocked_id>"

  Scenario: Ready with nothing actionable
    When I run ready
    Then the output should match "No actionable items found."
