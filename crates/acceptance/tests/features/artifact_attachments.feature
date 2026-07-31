Feature: Direct artifact attachments
  Create artifacts with each supported direct attachment target.

  Background:
    Given a configured Sacrum client

  Scenario: Default and explicit project attachments are visible on the project
    When I add artifact "default-project.md" with body "default project"
    Then the command should succeed
    And artifact "<artifact_id>" should be attached to "project" "<project_id>"
    When I add artifact "explicit-project.md" with body "explicit project" attached to "project" "<project_id>"
    Then the command should succeed
    And artifact "<artifact_id>" should be attached to "project" "<project_id>"

  Scenario: A task attachment is visible on its destination task
    Given I create a task with:
      | title | Artifact target task |
    When I add artifact "task-output.md" with body "task output" attached to "task" "<TASK_ID>"
    Then the command should succeed
    And artifact "<artifact_id>" should be attached to "task" "<TASK_ID>"

  Scenario: Task section, workflow, task run, and step execution targets are accepted
    Given I create a task with:
      | title | Artifact target resources |
    And I create an artifact task section fixture
    When I add artifact "section-output.md" with body "section output" attached to "task_section" "<section_id>"
    Then the command should succeed
    Given a workflow "artifact-target-workflow" with steps "execute:execute"
    When I add artifact "workflow-output.md" with body "workflow output" attached to "workflow" "<workflow_id>"
    Then the command should succeed
    Given I assign the workflow to the task
    When I run vtb "start-taskrun <TASK_ID>"
    Then the command should succeed
    When I store the latest TaskRun ID as "task_run_id"
    When I create an artifact step execution
    When I add artifact "run-output.md" with body "run output" attached to "task_run" "<task_run_id>"
    Then the command should succeed
    When I add artifact "step-output.md" with body "step output" attached to "step_execution" "<step_execution_id>"
    Then the command should succeed
    When I run vtb "stop-taskrun <TASK_ID>"
    Then the command should succeed
