Feature: Show task details
  Display full task information including metadata, sections, relationships, and code refs.

  Background:
    Given a configured Sacrum client

  @cleanup
  Scenario: Show task displays metadata
    Given I create a task with:
      | title       | Show test task |
      | level       | ticket         |
      | description | Some details   |
      | priority    | critical       |
    When I show the task
    Then the output should contain "Task: <TASK_ID> - Show test task"
    And the output should contain "Level:    ticket"
    And the output should contain "Priority: critical"
    And the output should contain "Some details"

  @cleanup
  Scenario: Show task displays parent relationship
    Given I create a task titled "Parent epic" with level "epic"
    And I store the task ID as "parent_id"
    And I create a task titled "Child task" with parent "<parent_id>"
    When I show the task
    Then the output should contain "Parent: <parent_id>"

  @cleanup
  Scenario: Show task displays children
    Given I create a task titled "Parent" with level "epic"
    And I store the task ID as "parent_id"
    And I create a task titled "Child A" with parent "<parent_id>"
    And I store the task ID as "child_a"
    And I create a task titled "Child B" with parent "<parent_id>"
    And I store the task ID as "child_b"
    When I show the task "<parent_id>"
    Then the output should contain "Children:"
    And the output should contain "<child_a>"
    And the output should contain "<child_b>"

  @cleanup
  Scenario: Show task displays blockers (filtered to incomplete)
    Given I create a task titled "Blocker"
    And I store the task ID as "blocker_id"
    And I create a task titled "Blocked" with depends-on "<blocker_id>"
    When I show the task
    Then the output should contain "Blocked by:"
    And the output should contain "<blocker_id>"

  @cleanup
  Scenario: Show task displays human review flag
    Given I create a task titled "Review task" with needs-review
    When I show the task
    Then the output should contain "Human Review: True"

  Scenario: Show non-existent task fails
    When I attempt to show task "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "Task not found: 00000000-0000-4000-8000-000000000000"
    And the hint should contain "Use 'vtb list' to see available tasks"
