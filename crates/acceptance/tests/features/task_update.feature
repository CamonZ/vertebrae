Feature: Update tasks
  Modify task fields including title, description, priority, tags, parent, and worktree.

  Background:
    Given a configured Sacrum client

  @cleanup
  Scenario: Update title
    Given I create a task titled "Original title"
    When I update the task with --title "Updated title"
    Then the task title should be "Updated title"

  @cleanup
  Scenario: Update description
    Given I create a task titled "Desc task"
    When I update the task with --description "New description"
    Then the task description should be "New description"

  @cleanup
  Scenario: Clear description with empty string
    Given I create a task titled "Clear desc" with description "Old desc"
    When I update the task with --description ""
    Then the task description should be empty

  @cleanup
  Scenario: Update priority
    Given I create a task titled "Priority task" with priority "low"
    When I update the task with --priority "critical"
    Then the task priority should be "critical"

  @cleanup
  Scenario: Add tags
    Given I create a task titled "Tag task"
    When I update the task with --add-tag "backend" --add-tag "urgent"
    Then the task should have tags "backend", "urgent"

  @cleanup
  Scenario: Remove tag
    Given I create a task titled "Tag removal" with tags "frontend", "backend", "urgent"
    When I update the task with --remove-tag "urgent"
    Then the task should have tags "frontend", "backend"
    And the task should not have tag "urgent"

  @cleanup
  Scenario: Set parent
    Given I create a task titled "Parent epic" with level "epic"
    And I store the task ID as "parent_id"
    And I create a task titled "Orphan task"
    When I update the task with --parent "<parent_id>"
    Then the task parent_id should match "<parent_id>"

  @cleanup
  Scenario: Remove parent with empty string
    Given I create a task titled "Parent" with level "epic"
    And I store the task ID as "parent_id"
    And I create a task titled "Child" with parent "<parent_id>"
    When I update the task with --parent ""
    Then the task parent_id should be empty

  @cleanup
  Scenario: Set worktree path
    Given I create a task titled "Worktree task"
    When I update the task with --worktree "/tmp/my-worktree"
    Then the task worktree should be "/tmp/my-worktree"

  @cleanup
  Scenario: Clear worktree with empty string
    Given I create a task titled "Worktree task"
    When I update the task with --worktree "/tmp/my-worktree"
    And I update the task with --worktree ""
    Then the task worktree should be empty

  Scenario: Update non-existent task fails
    When I attempt to update task "00000000-0000-4000-8000-000000000000" with --title "New"
    Then the command should fail with "Task not found: 00000000-0000-4000-8000-000000000000"

  @cleanup
  Scenario: Self-parent is rejected
    Given I create a task titled "Self parent"
    And I store the task ID as "task_id"
    When I attempt to update the task with --parent "<task_id>"
    Then the command should fail with "Validation failed: Cannot set task as its own parent"

  @cleanup
  Scenario: Non-existent parent is rejected
    Given I create a task titled "Bad parent"
    When I attempt to update the task with --parent "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "Parent task not found: 00000000-0000-4000-8000-000000000000"
