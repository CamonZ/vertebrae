Feature: List tasks
  Query and filter tasks with various criteria.

  Background:
    Given a configured Sacrum client

  Scenario: List returns created tasks
    Given I create a task with:
      | title | List task A |
    And I store the task ID as "task_a"
    And I create a task with:
      | title | List task B |
    And I store the task ID as "task_b"
    When I list tasks
    Then the output should contain "<task_a>"
    And the output should contain "<task_b>"

  Scenario: Filter by level
    Given I create a task with:
      | title | Epic item |
      | level | epic      |
    And I store the task ID as "epic_id"
    And I create a task with:
      | title | Ticket item |
      | level | ticket      |
    And I store the task ID as "ticket_id"
    When I list tasks with:
      | level | epic |
    Then the output should contain "<epic_id>"
    And the output should not contain "<ticket_id>"

  Scenario Outline: Filter by each priority value
    Given I create a task with:
      | title    | Target task     |
      | priority | <target>        |
    And I store the task ID as "target_id"
    And I create a task with:
      | title    | Other task      |
      | priority | <other>         |
    And I store the task ID as "other_id"
    When I list tasks with:
      | priority | <target> |
    Then the output should contain "<target_id>"
    And the output should not contain "<other_id>"

    Examples:
      | target   | other    |
      | low      | critical |
      | medium   | low      |
      | high     | medium   |
      | critical | high     |

  Scenario: Filter by tag
    Given I create a task with:
      | title | Backend |
      | tags  | backend |
    And I store the task ID as "backend_id"
    And I create a task with:
      | title | Frontend |
      | tags  | frontend |
    And I store the task ID as "frontend_id"
    When I list tasks with:
      | tag | backend |
    Then the output should contain "<backend_id>"
    And the output should not contain "<frontend_id>"

  Scenario: Filter by root only
    Given I create a task with:
      | title | Root epic |
      | level | epic      |
    And I store the task ID as "root_id"
    And I create a task with:
      | title  | Child task |
      | parent | <root_id>  |
    And I store the task ID as "child_id"
    When I list tasks with:
      | root | true |
    Then the output should contain "<root_id>"
    And the output should not contain "<child_id>"

  Scenario: Filter by parent
    Given I create a task with:
      | title | Parent |
      | level | epic   |
    And I store the task ID as "parent_id"
    And I create a task with:
      | title  | Child       |
      | parent | <parent_id> |
    And I store the task ID as "child_id"
    And I create a task with:
      | title | Unrelated |
    And I store the task ID as "unrelated_id"
    When I list tasks with:
      | parent | <parent_id> |
    Then the output should contain "<child_id>"
    And the output should not contain "<unrelated_id>"

  Scenario: Search by text
    Given I create a task with:
      | title | Database migration |
    And I store the task ID as "db_id"
    And I create a task with:
      | title | API refactor |
    And I store the task ID as "api_id"
    When I list tasks with:
      | search | Database |
    Then the output should contain "<db_id>"
    And the output should not contain "<api_id>"

  Scenario: No priority filter returns tasks of all priorities
    Given I create a task with:
      | title    | Low priority   |
      | priority | low            |
    And I store the task ID as "low_id"
    And I create a task with:
      | title    | High priority  |
      | priority | high           |
    And I store the task ID as "high_id"
    When I list tasks
    Then the output should contain "<low_id>"
    And the output should contain "<high_id>"

  Scenario: No level filter returns tasks of all levels
    Given I create a task with:
      | title | Epic item  |
      | level | epic       |
    And I store the task ID as "epic_id"
    And I create a task with:
      | title | Task item  |
      | level | task       |
    And I store the task ID as "task_id"
    When I list tasks
    Then the output should contain "<epic_id>"
    And the output should contain "<task_id>"

  Scenario: No tag filter returns tasks regardless of tags
    Given I create a task with:
      | title | Tagged     |
      | tags  | special    |
    And I store the task ID as "tagged_id"
    And I create a task with:
      | title | Untagged   |
    And I store the task ID as "untagged_id"
    When I list tasks
    Then the output should contain "<tagged_id>"
    And the output should contain "<untagged_id>"

  Scenario: No root filter returns both root and child tasks
    Given I create a task with:
      | title | Parent epic |
      | level | epic        |
    And I store the task ID as "parent_id"
    And I create a task with:
      | title  | Child task  |
      | parent | <parent_id> |
    And I store the task ID as "child_id"
    When I list tasks
    Then the output should contain "<parent_id>"
    And the output should contain "<child_id>"

  Scenario: Empty search query is rejected
    When I list tasks with:
      | search | |
    Then the command should fail with "Validation failed: Search query cannot be empty"
