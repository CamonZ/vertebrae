Feature: Update tasks
  Modify task fields including title, description, priority, tags, parent, and worktree.

  Background:
    Given a configured Sacrum client

  Scenario: Update title
    Given I create a task with:
      | title | Original title |
    When I update the task with:
      | title | Updated title |
    Then the task title should be "Updated title"

  Scenario: Update description
    Given I create a task with:
      | title | Desc task |
    When I update the task with:
      | description | New description |
    Then the task description should be "New description"

  Scenario: Clear description with empty string
    Given I create a task with:
      | title       | Clear desc |
      | description | Old desc   |
    When I update the task with:
      | description | |
    Then the task description should be empty

  Scenario Outline: Update priority to each value
    Given I create a task with:
      | title    | Priority task |
      | priority | <from>        |
    When I update the task with:
      | priority | <to> |
    Then the task priority should be "<to>"

    Examples:
      | from     | to       |
      | low      | medium   |
      | medium   | high     |
      | high     | critical |
      | critical | low      |

  Scenario: Add tags
    Given I create a task with:
      | title | Tag task |
    When I update the task with:
      | add_tags | backend, urgent |
    Then the task should have tags "backend, urgent"

  Scenario: Remove tag
    Given I create a task with:
      | title | Tag removal               |
      | tags  | frontend, backend, urgent |
    When I update the task with:
      | remove_tag | urgent |
    Then the task should have tags "frontend, backend"
    And the task should not have tag "urgent"

  Scenario: Set parent
    Given I create a task with:
      | title | Parent epic |
      | level | epic        |
    And I store the task ID as "parent_id"
    And I create a task with:
      | title | Orphan task |
    When I update the task with:
      | parent | <parent_id> |
    Then the task parent_id should match "<parent_id>"

  Scenario: Remove parent with empty string
    Given I create a task with:
      | title | Parent |
      | level | epic   |
    And I store the task ID as "parent_id"
    And I create a task with:
      | title  | Child       |
      | parent | <parent_id> |
    When I update the task with:
      | parent | |
    Then the task parent_id should be empty

  Scenario: Set worktree path
    Given I create a task with:
      | title | Worktree task |
    When I update the task with:
      | worktree | /tmp/my-worktree |
    Then the task worktree should be "/tmp/my-worktree"

  Scenario: Clear worktree with empty string
    Given I create a task with:
      | title | Worktree task |
    When I update the task with:
      | worktree | /tmp/my-worktree |
    And I update the task with:
      | worktree | |
    Then the task worktree should be empty

  Scenario: Update non-existent task fails
    When I update task "00000000-0000-4000-8000-000000000000" with:
      | title | New |
    Then the command should fail with "Task not found:"

  Scenario: Self-parent is rejected
    Given I create a task with:
      | title | Self parent |
    And I store the task ID as "task_id"
    When I update the task with:
      | parent | <task_id> |
    Then the command should fail with "Validation failed: Cannot set task as its own parent"

  Scenario: Non-existent parent is rejected
    Given I create a task with:
      | title | Bad parent |
    When I update the task with:
      | parent | 00000000-0000-4000-8000-000000000000 |
    Then the command should fail with "Parent task not found: 00000000-0000-4000-8000-000000000000"

