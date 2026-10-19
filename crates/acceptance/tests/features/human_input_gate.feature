Feature: human_input gate config and resolution
  A human_input step is authored with a role, a question, the artifact that
  resolves it, and the output schema its response must satisfy. Attaching
  that artifact to the waiting execution resolves the gate; Sacrum's
  rejections are printed so the caller can correct the response.

  Background:
    Given a configured Sacrum client
    And a workflow "human-input-wf" with steps "draft, gate:human_input, done:finish"

  Scenario: A human_input step's config is created, shown, and stored by Sacrum
    When I add a human_input step "Review" with role "Review as a release manager" and question from a file containing "Review {{ task.title }}", artifact "review", and the approval output schema
    Then the command should succeed
    And Sacrum should store the human_input step "Review" with role "Review as a release manager" and question "Review {{ task.title }}", artifact "review", and the approval output schema
    When I show the step "Review"
    Then the output should contain "Role:          Review as a release manager"
    And the output should contain "Question:      Review {{ task.title }}"
    And the output should contain "Artifact:      review"
    And the output should contain '"approved"'
    When I show the step "Review" as JSON
    Then the step show JSON config should have artifact "review"

  Scenario: A human_input step's config is updated and cleared
    When I configure the human_input step "gate" with role "Review as a release manager" and question "Approve {{ task.title }}?", artifact "approval", and the approval output schema
    Then Sacrum should store the human_input step "gate" with role "Review as a release manager" and question "Approve {{ task.title }}?", artifact "approval", and the approval output schema
    When I clear the human_input role, question and artifact of step "gate"
    Then the command should succeed
    And Sacrum should store the human_input step "gate" with only the approval output schema
    When I show the step "gate"
    Then the output should contain "Role:          (none)"
    And the output should contain "Question:      (none)"
    And the output should contain "Artifact:      (none)"

  Scenario: Only human_input steps take gate flags
    When I add a step "Plain" to the workflow with flag "--artifact" and value "approval"
    Then the command should fail with "$.artifact: is not supported for llm_inference steps"
    When I add a step "Plain" to the workflow with flag "--question" and value "Approve"
    Then the command should fail with "$.question: is not supported for llm_inference steps"

  Scenario: Gate rejections are printed distinctly and a conforming response resumes the run
    Given the human_input step "gate" is configured with role "Review as a release manager" and question "Approve {{ task.title }}?", artifact "approval", and the approval output schema
    And I create a task with:
      | title | Ship parser |
    And I assign the workflow to the task
    When I transition the task to step "gate" with --skip-validation
    Then the command should succeed
    When I run vtb "start-taskrun <TASK_ID>"
    Then the command should succeed
    When I store the latest TaskRun ID as "task_run_id"
    And the TaskRun "task_run_id" is waiting at the human_input gate
    Then the waiting execution should carry role "Review as a release manager", question "Approve Ship parser?" and artifact "approval"
    When I attach "yes" as "approval" to the waiting execution
    Then the command should fail with "Human input rejected: artifact body is not valid JSON:"
    And the hint should contain "must be a JSON document"
    When I attach '{"approved": "yes"}' as "approval" to the waiting execution
    Then the command should fail with "Human input rejected: the response does not satisfy the gate's output_schema:"
    And the error should contain "  - #/approved:"
    And the error should contain "  - #:"
    And the hint should contain "Fix each listed path"
    When I attach '{"approved": true, "reason": "Looks good"}' as "approval" to the waiting execution
    Then the command should succeed
    And the TaskRun "task_run_id" should reach status "completed"

  Scenario: Attaching to a gate whose run was stopped reports it is no longer waiting
    Given the human_input step "gate" is configured with role "Review as a release manager" and question "Approve {{ task.title }}?", artifact "approval", and the approval output schema
    And I create a task with:
      | title | Stopped gate |
    And I assign the workflow to the task
    When I transition the task to step "gate" with --skip-validation
    And I run vtb "start-taskrun <TASK_ID>"
    And I store the latest TaskRun ID as "task_run_id"
    And the TaskRun "task_run_id" is waiting at the human_input gate
    And I run vtb "stop-taskrun <TASK_ID>"
    Then the command should succeed
    And the TaskRun "task_run_id" should reach status "stopped"
    When I attach '{"approved": true, "reason": "Too late"}' as "approval" to the waiting execution
    Then the command should fail with "Human input rejected: step execution is not waiting for human input"
    And the hint should contain "current waiting execution"

  Scenario: A draftable gate is answered field by field and submitted from its draft
    Given the human_input step "gate" is configured with role "Review as a release manager" and question "Approve {{ task.title }}?", artifact "approval", and the approval output schema
    And I create a task with:
      | title | Draft parser |
    And I assign the workflow to the task
    When I transition the task to step "gate" with --skip-validation
    And I run vtb "start-taskrun <TASK_ID>"
    And I store the latest TaskRun ID as "task_run_id"
    And the TaskRun "task_run_id" is waiting at the human_input gate
    And I run vtb "gate show <step_execution_id>"
    Then the command should succeed
    And the output should contain "Answered: none yet"
    And the output should contain "Still needed: approved, reason"
    When I set the waiting gate's draft to '{"approved": true}'
    Then the command should succeed
    And the output should contain "  approved: true"
    And the output should contain "Still needed: reason"
    When I set the waiting gate's draft to '{"nope": 1}'
    Then the command should fail with "Human input rejected: not a property of the gate's output_schema: nope"
    And the hint should contain "vtb gate show"
    When I set the waiting gate's draft to '{"approved": "yes"}'
    Then the command should fail with "Human input rejected: the response does not satisfy the gate's output_schema:"
    And the error should contain "/approved"
    When I run vtb "gate submit <step_execution_id>"
    Then the command should fail with "Human input rejected: draft is missing required fields: reason"
    And the hint should contain "vtb gate set"
    When I set the waiting gate's draft to '{"reason": "Looks good"}'
    Then the command should succeed
    And the output should contain "Complete — confirm with the user, then submit."
    When I run vtb "gate submit <step_execution_id>"
    Then the command should succeed
    And the output should contain "the gate is resolved"
    And the TaskRun "task_run_id" should reach status "completed"
    When I run vtb "gate show <step_execution_id>"
    Then the command should succeed
    And the output should contain '  reason: "Looks good"'
