Feature: Artifact lifecycle
  Manage project-scoped artifacts through the real vtb CLI.

  Background:
    Given a configured Sacrum client

  Scenario: Add, list, show, update, and delete an artifact
    When I add artifact "lifecycle.md" with body "initial body"
    Then the command should succeed
    And the output should contain "Created artifact:"
    When I list artifacts as JSON
    Then the command should succeed
    And the artifact list should include "<artifact_id>" with filename "lifecycle.md" and body "initial body"
    And every listed artifact should belong to the active project
    When I show artifact "<artifact_id>" as JSON
    Then the artifact JSON should have filename "lifecycle.md" and body "initial body"
    When I update artifact "<artifact_id>" with filename "updated.md" and body "updated body"
    Then the command should succeed
    And the output should contain "Updated artifact: <artifact_id>"
    When I show artifact "<artifact_id>" as JSON
    Then the artifact JSON should have filename "updated.md" and body "updated body"
    When I delete artifact "<artifact_id>" with --force
    Then the command should succeed
    And the output should contain "Deleted artifact: <artifact_id>"
    When I show artifact "<artifact_id>" as JSON
    Then the command should fail with "not found"

  Scenario: Project list returns multiple artifacts from the active project
    When I add artifact "first.md" with body "first body" as "first_artifact"
    Then the command should succeed
    When I add artifact "second.md" with body "second body" as "second_artifact"
    Then the command should succeed
    When I list artifacts as JSON
    Then the command should succeed
    And the artifact list should include "<first_artifact>" with filename "first.md" and body "first body"
    And the artifact list should include "<second_artifact>" with filename "second.md" and body "second body"
    And every listed artifact should belong to the active project

  Scenario: Add an artifact attached to a task
    Given I create a task with:
      | title | Artifact target task |
    When I add artifact "task-output.md" with body "task output" attached to "task" "<TASK_ID>"
    Then the command should succeed
    And the output should contain "Created artifact:"
    When I show artifact "<artifact_id>" as JSON
    Then the artifact JSON should have filename "task-output.md" and body "task output"
