Feature: Smoke test
  Validates the full pipeline: sacrum-client -> Sacrum GraphQL API -> Postgres

  Scenario: Create and delete a task
    Given a configured Sacrum client
    When I create a task with:
      | title | Smoke test task |
    Then the task should exist with title "Smoke test task"
    When I delete the task
    Then the task should no longer exist
