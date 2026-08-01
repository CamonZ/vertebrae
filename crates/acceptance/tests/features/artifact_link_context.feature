Feature: Artifact link metadata and logical-name context
  Exercise link provenance, subject-local lookup, and atomic reattachment
  against the running Sacrum service.

  Background:
    Given a configured Sacrum client

  Scenario: Project attachment accepts inline metadata and renders link context
    When I add artifact "project-result.md" with body "project body", logical name "project-result", and inline metadata attached to "project" "<project_id>" as "project_artifact"
    Then the command should succeed
    And the artifact JSON operation should be "created" with logical name "project-result" and metadata content kind "result"
    And artifact "<project_artifact>" should be attached to "project" "<project_id>"
    When I look up artifact logical name "project-result" on "project" "<project_id>" for humans
    Then the command should succeed
    And the output should contain "Logical name: project-result"
    And the output should contain "Metadata:"
    And the output should contain "artifact-links"
    When I look up artifact logical name "project-result" on "project" "<project_id>" as JSON
    Then the artifact JSON should have filename "project-result.md" and body "project body"
    And the artifact JSON should have logical name "project-result" and metadata content kind "result"

  Scenario: Task metadata file survives a link-only reattachment to a step execution
    Given I create a task with:
      | title | Artifact link task |
    When I add artifact "task-result.md" with body "task body", logical name "task-result", and metadata from a file attached to "task" "<TASK_ID>" as "task_artifact"
    Then the command should succeed
    And artifact "<task_artifact>" should be attached to "task" "<TASK_ID>"
    When I look up artifact logical name "task-result" on "task" "<TASK_ID>" as JSON
    Then the artifact JSON should have filename "task-result.md" and body "task body"
    And the artifact JSON should have logical name "task-result" and metadata content kind "result"
    Given a workflow "artifact-link-workflow" with steps "execute:execute"
    And I assign the workflow to the task
    When I run vtb "start-taskrun <TASK_ID>"
    Then the command should succeed
    When I store the latest TaskRun ID as "task_run_id"
    And I create an artifact step execution
    When I reattach artifact "<task_artifact>" to "step_execution" "<step_execution_id>" with logical name "execution-result" without changing its body
    Then the command should succeed
    And the artifact JSON operation should be "updated" with logical name "execution-result" and metadata content kind "result"
    And artifact "<task_artifact>" should be attached to "step_execution" "<step_execution_id>"
    When I look up artifact logical name "task-result" on "task" "<TASK_ID>" as JSON
    Then the command should fail with "not found"
    When I look up artifact logical name "execution-result" on "step_execution" "<step_execution_id>" as JSON
    Then the artifact JSON should have filename "task-result.md" and body "task body"
    And the artifact JSON should have logical name "execution-result" and metadata content kind "result"
    When I run vtb "stop-taskrun <TASK_ID>"
    Then the command should succeed

  Scenario: Invalid metadata, duplicate names, and missing lookups fail without new artifacts
    Given I create a task with:
      | title | Artifact link validation task |
    When I add artifact "invalid-metadata.md" with body "body" and invalid metadata
    Then the command should fail with "Validation failed: invalid artifact metadata JSON"
    When I list artifacts as JSON
    Then the command should succeed
    And the artifact list should not contain filename "invalid-metadata.md"
    When I add artifact "first-name.md" with body "first", logical name "duplicate", and inline metadata attached to "task" "<TASK_ID>" as "first_named_artifact"
    Then the command should succeed
    When I add artifact "duplicate-name.md" with body "second", logical name "duplicate", and inline metadata attached to "task" "<TASK_ID>" as "duplicate_named_artifact"
    Then the command should fail
    When I list artifacts as JSON
    Then the command should succeed
    And the artifact list should not contain filename "duplicate-name.md"
    When I look up artifact logical name "missing" on "task" "<TASK_ID>" as JSON
    Then the command should fail with "not found"

  Scenario: Representative artifact skill commands execute against Sacrum
    Given I create a task with:
      | title | Artifact skill example task |
    When I execute the documented artifact attachment example for the task as "skill_result"
    Then the command should succeed
    And the artifact JSON status should be "created"
    When I execute the documented artifact lookup example for the task
    Then the command should succeed
    And the artifact JSON should have logical name "result" and metadata content kind ""
    When I execute the documented metadata artifact example for the task as "skill_conversation"
    Then the command should succeed
    And the artifact JSON operation should be "created" with logical name "conversation" and metadata content kind "conversation"
    When I execute the documented artifact update example for "<skill_result>"
    Then the command should succeed
    And the artifact JSON status should be "updated"
