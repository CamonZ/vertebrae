Feature: Delete tasks
  Remove tasks with cascade and force options.

  Background:
    Given a configured Sacrum client

  Scenario: Delete simple task with force
    Given I create a task titled "Delete me"
    And I store the task ID as "task_id"
    When I delete the task with --force
    Then the output should match "Deleted task: <task_id>"
    And the task should no longer exist

  Scenario: Cascade delete removes all descendants
    Given I create a task titled "Root" with level "epic"
    And I store the task ID as "root_id"
    And I create a task titled "Child" with parent "<root_id>"
    And I store the task ID as "child_id"
    And I create a task titled "Grandchild" with parent "<child_id>"
    And I store the task ID as "grandchild_id"
    When I delete task "<root_id>" with --cascade --force
    Then the output should contain "Deleted 3 tasks (including children)"
    And task "<root_id>" should no longer exist
    And task "<child_id>" should no longer exist
    And task "<grandchild_id>" should no longer exist

  @cleanup
  Scenario: Force delete without cascade orphans children
    Given I create a task titled "Parent" with level "epic"
    And I store the task ID as "parent_id"
    And I create a task titled "Child" with parent "<parent_id>"
    And I store the task ID as "child_id"
    When I delete task "<parent_id>" with --force
    Then task "<parent_id>" should no longer exist
    And task "<child_id>" should still exist
    And task "<child_id>" should have no parent

  Scenario: Delete non-existent task fails
    When I attempt to delete task "00000000-0000-4000-8000-000000000000" with --force
    Then the command should fail with "Task not found: 00000000-0000-4000-8000-000000000000"
