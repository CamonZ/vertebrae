Feature: Parent/child orchestration via wait_children
  Sacrum's TaskOrchestrator handles the `wait_children` step server-side:
  on entry, the parent fans out to its direct children, persists a
  `waiting` StepExecution, and exits. Each child workflow runs through
  the daemon (the mock-claude spawns a completed execution). When every
  child reaches done, Sacrum wakes the parent, marks the waiting
  execution `completed`, and advances to a `work` step (dispatched to
  the daemon) before finishing.

  Scenario: Parent fans out to children and advances after they complete
    Given a configured daemon test environment
    And a child execute workflow that succeeds via mock claude
    And a parent wait_children workflow with a work step
    And a parent task assigned to the parent workflow
    And 2 child tasks assigned to the child workflow
    When I orchestrate the parent task
    And I wait for all children to reach completion
    And I wait for the parent waiting execution to reach status "completed"
    Then every child task is completed
    And the parent's waiting execution has status "completed"
    And the parent task has a completed step execution for the work step
    And the parent task is done
    And the parent wait_children step was handled without daemon dispatch

  Scenario: Parent wakes only after full subtree (grandchildren) completes
    Given a configured daemon test environment
    And a child execute workflow that succeeds via mock claude
    And a parent wait_children workflow with a work step
    And a parent task assigned to the parent workflow
    And 1 intermediate child assigned to a wait_children workflow
    And 2 grandchildren under the intermediate child assigned to the child workflow
    When I orchestrate the parent task
    And I wait for all grandchildren to reach completion
    And I wait for the parent waiting execution to reach status "completed"
    Then every grandchild task is completed
    And the intermediate child's waiting execution has status "completed"
    And the parent's waiting execution has status "completed"
    And the parent task is done

  Scenario: Parent wakes only after dependency-ordered children finish in order
    Given a configured daemon test environment
    And a child execute workflow that succeeds via mock claude
    And a parent wait_children workflow with a work step
    And a parent task assigned to the parent workflow
    And 3 dependency-ordered child tasks assigned to the child workflow
    When I orchestrate the parent task
    And I wait for all children to reach completion
    And I wait for the parent waiting execution to reach status "completed"
    Then every child task is completed
    And the parent's wait_children execution started before child 1 started
    And child 1 completed before child 2 started
    And child 2 completed before child 3 started
    And the parent's work execution started after child 3 completed
    And the parent's waiting execution has status "completed"
    And the parent task is done
