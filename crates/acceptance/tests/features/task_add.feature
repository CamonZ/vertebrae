Feature: Add tasks
  Create tasks with various options via the CLI.

  Background:
    Given a configured Sacrum client

  Scenario: Create task with title only
    When I create a task with:
      | title | Minimal task |
    Then the task should exist with title "Minimal task"
    And the task level should be "task"
    And the command should succeed

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

  Scenario Outline: Create task with each level
    When I create a task with:
      | title | Level test |
      | level | <level>    |
    Then the task level should be "<level>"

    Examples:
      | level  |
      | epic   |
      | ticket |
      | task   |

  Scenario Outline: Create task with each priority
    When I create a task with:
      | title    | Priority test |
      | priority | <priority>    |
    Then the task priority should be "<priority>"

    Examples:
      | priority |
      | low      |
      | medium   |
      | high     |
      | critical |

  Scenario: Create task with multiple tags
    When I create a task with:
      | title | Tagged                    |
      | tags  | backend, database, urgent |
    Then the task should have tags "backend, database, urgent"

  Scenario: Create task with needs-review flag
    When I create a task with:
      | title        | Needs review |
      | needs_review | true         |
    Then the task needs_human_review should be "true"

  Scenario: Create child task with parent
    Given I create a task with:
      | title | Parent epic |
      | level | epic        |
    And I store the task ID as "parent_id"
    When I create a task with:
      | title  | Child ticket |
      | parent | <parent_id>  |
    Then the task parent_id should match "<parent_id>"

  Scenario: Create task with dependency
    Given I create a task with:
      | title | Blocker |
    And I store the task ID as "blocker_id"
    When I create a task with:
      | title      | Dependent    |
      | depends_on | <blocker_id> |
    Then the task should be blocked by "<blocker_id>"

  Scenario: Create task with track
    When I create a task with:
      | title | Frontend task |
      | track | frontend      |
    Then the command should succeed
    And the task track should be "frontend"

  Scenario: Create task without track
    When I create a task with:
      | title | No track task |
    Then the command should succeed
    And the task track should be empty

  Scenario: Empty title is rejected
    When I create a task with:
      | title | |
    Then the command should fail with "Validation failed: title required"

  Scenario: Whitespace-only title is rejected
    When I create a task with:
      | title |    |
    Then the command should fail with "Validation failed: title required"
