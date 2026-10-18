Feature: human_input gate config and resolution
  A human_input step is authored with instructions, the artifact that
  resolves it, and the output schema its response must satisfy. Attaching
  that artifact to the waiting execution resolves the gate; Sacrum's
  rejections are printed so the caller can correct the response.

  Background:
    Given a configured Sacrum client
    And a workflow "human-input-wf" with steps "draft, gate:human_input, done:finish"

  Scenario: A human_input step's config is created, shown, and stored by Sacrum
    When I add a human_input step "Review" with instructions from a file containing "Review {{ task.title }}", artifact "review", and the approval output schema
    Then the command should succeed
    And Sacrum should store the human_input step "Review" with instructions "Review {{ task.title }}", artifact "review", and the approval output schema
    When I show the step "Review"
    Then the output should contain "Instructions:  Review {{ task.title }}"
    And the output should contain "Artifact:      review"
    And the output should contain '"approved"'
    When I show the step "Review" as JSON
    Then the step show JSON config should have artifact "review"

  Scenario: A human_input step's config is updated and cleared
    When I configure the human_input step "gate" with instructions "Approve {{ task.title }}?", artifact "approval", and the approval output schema
    Then Sacrum should store the human_input step "gate" with instructions "Approve {{ task.title }}?", artifact "approval", and the approval output schema
    When I clear the human_input instructions and artifact of step "gate"
    Then the command should succeed
    And Sacrum should store the human_input step "gate" with only the approval output schema
    When I show the step "gate"
    Then the output should contain "Instructions:  (none)"
    And the output should contain "Artifact:      (none)"

  Scenario: Only human_input steps take gate flags
    When I add a step "Plain" to the workflow with flag "--artifact" and value "approval"
    Then the command should fail with "$.artifact: is not supported for llm_inference steps"
    When I add a step "Plain" to the workflow with flag "--instructions" and value "Approve"
    Then the command should fail with "$.instructions: is not supported for llm_inference steps"

  Scenario: Gate rejections are printed distinctly and a conforming response resumes the run
    Given the human_input step "gate" is configured with instructions "Approve {{ task.title }}?", artifact "approval", and the approval output schema
    And I create a task with:
      | title | Ship parser |
    And I assign the workflow to the task
    When I transition the task to step "gate" with --skip-validation
    Then the command should succeed
    When I run vtb "start-taskrun <TASK_ID>"
    Then the command should succeed
    When I store the latest TaskRun ID as "task_run_id"
    And the TaskRun "task_run_id" is waiting at the human_input gate
    Then the waiting execution should carry instructions "Approve Ship parser?" and artifact "approval"
    When I attach "yes" as "approval" to the waiting execution
    Then the command should fail with "Human input rejected: artifact body is not valid JSON:"
    And the hint should contain "must be a JSON document"
    When I attach '{"approved": "yes"}' as "approval" to the waiting execution
    Then the command should fail with "Human input rejected: artifact body does not satisfy the gate's output_schema:"
    And the error should contain "  - #/approved:"
    And the error should contain "  - #:"
    And the hint should contain "Fix each listed path"
    When I attach '{"approved": true, "reason": "Looks good"}' as "approval" to the waiting execution
    Then the command should succeed
    And the TaskRun "task_run_id" should reach status "completed"

  Scenario: Attaching to a gate whose run was stopped reports it is no longer waiting
    Given the human_input step "gate" is configured with instructions "Approve {{ task.title }}?", artifact "approval", and the approval output schema
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
