Feature: Add tasks
  Create tasks with various options via the Sacrum API.

  Background:
    Given a configured Sacrum client

  @cleanup
  Scenario: Create task with title only
    When I create a task titled "Minimal task"
    Then the task should exist with title "Minimal task"
    And the task level should be "task"
    And the output should match "Created task: <TASK_ID>"

  @cleanup
  Scenario: Create task with all basic fields
    When I create a task with:
      | title       | Full task          |
      | level       | epic               |
      | description | Detailed desc here |
      | priority    | high               |
    Then the task should exist with title "Full task"
    And the task level should be "epic"
    And the task description should be "Detailed desc here"
    And the task priority should be "high"

  @cleanup
  Scenario Outline: Create task with each level
    When I create a task titled "Level test" with level "<level>"
    Then the task level should be "<level>"

    Examples:
      | level  |
      | epic   |
      | ticket |
      | task   |

  @cleanup
  Scenario Outline: Create task with each priority
    When I create a task titled "Priority test" with priority "<priority>"
    Then the task priority should be "<priority>"

    Examples:
      | priority |
      | low      |
      | medium   |
      | high     |
      | critical |

  @cleanup
  Scenario: Create task with multiple tags
    When I create a task titled "Tagged" with tags:
      | backend  |
      | database |
      | urgent   |
    Then the task should have tags "backend", "database", "urgent"

  @cleanup
  Scenario: Create task with needs-review flag
    When I create a task titled "Needs review" with needs-review
    Then the task needs_human_review should be true

  @cleanup
  Scenario: Create child task with parent
    Given I create a task titled "Parent epic" with level "epic"
    And I store the task ID as "parent_id"
    When I create a task titled "Child ticket" with parent "<parent_id>"
    Then the task parent_id should match "<parent_id>"

  @cleanup
  Scenario: Create task with dependency
    Given I create a task titled "Blocker"
    And I store the task ID as "blocker_id"
    When I create a task titled "Dependent" with depends-on "<blocker_id>"
    Then the task should be blocked by "<blocker_id>"

  Scenario: Empty title is rejected
    When I attempt to create a task with title ""
    Then the command should fail with "Validation failed: title required"

  Scenario: Whitespace-only title is rejected
    When I attempt to create a task with title "   "
    Then the command should fail with "Validation failed: title required"
