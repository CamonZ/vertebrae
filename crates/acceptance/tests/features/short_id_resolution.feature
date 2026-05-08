Feature: Short ID resolution across all commands
  Verify that vtb correctly resolves 8-character hex prefixes (short IDs)
  to full UUIDs for every command and flag site that accepts an ID. Each
  scenario invokes one command via the binary using a short ID and asserts
  the command succeeds (or, for negative scenarios, fails with a clear
  "not found" error rather than a UUID parse error).

  Background:
    Given a configured Sacrum client

  # ============================================================
  # Task-ID positional commands
  # ============================================================

  Scenario: show resolves task short ID
    Given I create a task with:
      | title | Show target |
    And I store the task ID as "full"
    And I store the task short ID as "s"
    When I run vtb "show <s>"
    Then the command should succeed
    And the output should contain "Show target"
    And the output should contain "<full>"

  Scenario: archive resolves task short ID
    Given I create a task with:
      | title | Archive target |
    And I store the task short ID as "s"
    When I run vtb "archive <s>"
    Then the command should succeed
    And the output should contain "archived"

  Scenario: unarchive resolves task short ID
    Given I create a task with:
      | title | Unarchive target |
    And I store the task short ID as "s"
    And I archive the task
    When I run vtb "unarchive <s>"
    Then the command should succeed
    And the output should contain "unarchived"

  Scenario: delete resolves task short ID
    Given I create a task with:
      | title | Delete target |
    And I store the task ID as "full"
    And I store the task short ID as "s"
    When I run vtb "delete <s> --force"
    Then the command should succeed
    And the output should contain "<full>"

  Scenario: refs resolves task short ID
    Given I create a task with:
      | title | Refs target |
    And I store the task short ID as "s"
    When I run vtb "refs <s>"
    Then the command should succeed

  Scenario: sections resolves task short ID
    Given I create a task with:
      | title | Sections target |
    And I store the task short ID as "s"
    When I run vtb "sections <s>"
    Then the command should succeed

  Scenario: review resolves task short ID
    Given I create a task with:
      | title | Review target |
    And I store the task short ID as "s"
    When I run vtb "review <s>"
    Then the command should succeed

  Scenario: blockers resolves task short ID
    Given I create a task with:
      | title | Blockers target |
    And I store the task short ID as "s"
    When I run vtb "blockers <s>"
    Then the command should succeed
    And the output should contain "No blockers"

  Scenario: run resolves task short ID
    Given I create a task with:
      | title | Run target |
    And I store the task short ID as "s"
    When I run vtb "run <s>"
    Then the error should not contain "is not a valid UUID or short ID"

  Scenario: run-workflow resolves task short ID
    Given I create a task with:
      | title | Run-workflow target |
    And I store the task short ID as "s"
    When I run vtb "run-workflow <s>"
    Then the error should not contain "is not a valid UUID or short ID"

  Scenario: start-taskrun resolves task short ID
    Given I create a task with:
      | title | Start TaskRun target |
    And I store the task short ID as "s"
    When I run vtb "start-taskrun <s>"
    Then the error should not contain "is not a valid UUID or short ID"

  Scenario: stop resolves task short ID
    Given I create a task with:
      | title | Stop target |
    And I store the task short ID as "s"
    When I run vtb "stop <s>"
    Then the error should not contain "is not a valid UUID or short ID"

  Scenario: stop-taskrun resolves task short ID
    Given I create a task with:
      | title | Stop TaskRun target |
    And I store the task short ID as "s"
    When I run vtb "stop-taskrun <s>"
    Then the error should not contain "is not a valid UUID or short ID"

  Scenario: transition-to resolves task short ID
    Given a workflow "tx-wf" with steps "alpha, beta"
    And I create a task with:
      | title | Transition target |
    And I assign the workflow to the task
    And I store the task short ID as "s"
    When I run vtb "transition-to <s> beta"
    Then the command should succeed

  Scenario: update resolves task short ID
    Given I create a task with:
      | title | Update target |
    And I store the task short ID as "s"
    When I run vtb "update <s> --title Renamed"
    Then the command should succeed
    And the task title should be "Renamed"

  # ============================================================
  # Task-ID positional commands with subactions
  # ============================================================

  Scenario: check-item resolves task short ID
    Given I create a task with:
      | title | Check target |
    And I store the task short ID as "s"
    And I run vtb "section <s> checklist_item Item-one"
    When I run vtb "check-item <s> 1"
    Then the command should succeed

  Scenario: uncheck-item resolves task short ID
    Given I create a task with:
      | title | Uncheck target |
    And I store the task short ID as "s"
    And I run vtb "section <s> checklist_item Item-one"
    And I run vtb "check-item <s> 1"
    When I run vtb "uncheck-item <s> 1"
    Then the command should succeed

  Scenario: ref resolves task short ID
    Given I create a task with:
      | title | Ref target |
    And I store the task short ID as "s"
    When I run vtb "ref <s> src/foo.rs:L10"
    Then the command should succeed

  Scenario: unref resolves task short ID
    Given I create a task with:
      | title | Unref target |
    And I store the task short ID as "s"
    And I run vtb "ref <s> src/foo.rs:L10"
    When I run vtb "unref <s> 1"
    Then the command should succeed

  Scenario: section resolves task short ID
    Given I create a task with:
      | title | Section target |
    And I store the task short ID as "s"
    When I run vtb "section <s> constraint Must-handle-X"
    Then the command should succeed

  Scenario: unsection resolves task short ID
    Given I create a task with:
      | title | Unsection target |
    And I store the task short ID as "s"
    And I run vtb "section <s> constraint Must-handle-X"
    When I run vtb "unsection <s> constraint --index 0"
    Then the command should succeed

  Scenario: criterion-ref resolves task short ID
    Given I create a task with:
      | title | Criterion target |
    And I store the task short ID as "s"
    And I run vtb "section <s> testing_criterion Verify-X"
    When I run vtb "criterion-ref <s> 1 src/foo.rs:L10"
    Then the command should succeed

  # ============================================================
  # Dual-task commands
  # ============================================================

  Scenario: depend resolves task short IDs in both positional and --on
    Given I create a task with:
      | title | Dep A |
    And I store the task ID as "a_full"
    And I store the task short ID as "a"
    And I create a task with:
      | title | Dep B |
    And I store the task ID as "b_full"
    And I store the task short ID as "b"
    When I run vtb "depend <a> --on <b>"
    Then the command should succeed
    And the output should contain "<a_full>"
    And the output should contain "<b_full>"

  Scenario: undepend resolves task short IDs in both positional and --on
    Given I create a task with:
      | title | Undep A |
    And I store the task short ID as "a"
    And I create a task with:
      | title | Undep B |
    And I store the task short ID as "b"
    And I run vtb "depend <a> --on <b>"
    When I run vtb "undepend <a> --on <b>"
    Then the command should succeed

  Scenario: path resolves both from and to task short IDs
    Given I create a task with:
      | title | Path A |
    And I store the task short ID as "a"
    And I create a task with:
      | title | Path B |
    And I store the task short ID as "b"
    And I run vtb "depend <a> --on <b>"
    When I run vtb "path <a> <b>"
    Then the command should succeed
    And the output should contain "Path A"
    And the output should contain "Path B"

  # ============================================================
  # add flags
  # ============================================================

  Scenario: add --parent resolves parent short ID
    Given I create a task with:
      | title | Parent task |
    And I store the task ID as "parent_full"
    And I store the task short ID as "p"
    When I run vtb "add Child-task --parent <p>"
    Then the command should succeed
    And the output should contain "Created task:"
    And the error should not contain "is not a valid UUID or short ID"

  Scenario: add --depends-on resolves dependency short ID
    Given I create a task with:
      | title | Blocker task |
    And I store the task short ID as "b"
    When I run vtb "add Dependent-task --depends-on <b>"
    Then the command should succeed
    And the output should contain "Created task:"
    And the error should not contain "is not a valid UUID or short ID"

  Scenario: add --workflow resolves workflow short ID
    Given a workflow "add-wf" with steps "one, two"
    And I store the workflow short ID as "w"
    When I run vtb "add Wf-task --workflow <w>"
    Then the command should succeed

  # ============================================================
  # update --parent
  # ============================================================

  Scenario: update --parent resolves parent short ID
    Given I create a task with:
      | title | Parent for update |
    And I store the task ID as "parent_full"
    And I store the task short ID as "p"
    And I create a task with:
      | title | Child to reparent |
    And I store the task short ID as "c"
    When I run vtb "update <c> --parent <p>"
    Then the command should succeed
    And the task parent_id should match "<parent_full>"

  # ============================================================
  # list filters (regression sites)
  # ============================================================

  Scenario: list --parent resolves parent short ID (regression)
    Given I create a task with:
      | title | List parent |
    And I store the task ID as "parent_full"
    And I store the task short ID as "p"
    And I create a task with:
      | title  | Child of parent  |
      | parent | <parent_full>    |
    And I store the task ID as "child_full"
    When I run vtb "list --parent <p>"
    Then the command should succeed
    And the output should contain "<child_full>"

  Scenario: list --workflow resolves workflow short ID (regression)
    Given a workflow "list-wf" with steps "one, two"
    And I store the workflow short ID as "w"
    And I create a task with:
      | title | List wf task |
    And I assign the workflow to the task
    And I store the task ID as "task_full"
    When I run vtb "list --workflow <w>"
    Then the command should succeed
    And the output should contain "<task_full>"

  Scenario: list --step resolves step short ID (regression)
    Given a workflow "list-step-wf" with steps "stepA, stepB"
    And I store the short ID of step "stepA" as "sa"
    And I create a task with:
      | title | List step task |
    And I assign the workflow to the task
    And I store the task ID as "task_full"
    When I run vtb "list --step <sa>"
    Then the command should succeed
    And the output should contain "<task_full>"

  # ============================================================
  # workflow assign / unassign
  # ============================================================

  Scenario: workflow assign resolves task and workflow short IDs
    Given a workflow "assign-wf" with steps "one, two"
    And I store the workflow short ID as "w"
    And I create a task with:
      | title | Assign target |
    And I store the task short ID as "s"
    When I run vtb "workflow assign <s> <w>"
    Then the command should succeed

  Scenario: workflow unassign resolves task short ID (regression)
    Given a workflow "unassign-wf" with steps "one, two"
    And I create a task with:
      | title | Unassign target |
    And I assign the workflow to the task
    And I store the task short ID as "s"
    When I run vtb "workflow unassign <s>"
    Then the error should not contain "is not a valid UUID or short ID"

  # ============================================================
  # workflow show / update / delete
  # ============================================================

  Scenario: workflow show resolves workflow short ID
    Given a workflow "show-wf" with steps "one, two"
    And I store the workflow short ID as "w"
    When I run vtb "workflow show <w>"
    Then the command should succeed
    And the output should contain "show-wf"

  Scenario: workflow update resolves workflow short ID
    Given a workflow "upd-wf" with steps "one, two"
    And I store the workflow short ID as "w"
    When I run vtb "workflow update <w> --description Updated-desc"
    Then the command should succeed

  Scenario: workflow delete resolves workflow short ID
    Given a workflow "del-wf" with steps "one, two"
    And I store the workflow short ID as "w"
    When I run vtb "workflow delete <w>"
    Then the command should succeed

  # ============================================================
  # workflow transition add / delete / list
  # ============================================================

  Scenario: workflow transition add resolves source and target workflow short IDs
    Given a workflow "src-wf" with steps "one, two"
    And I store the workflow short ID as "src"
    And a second workflow "dst-wf" with steps "alpha, beta"
    When I run vtb "workflow transition add <src> <second_workflow_id> --label approve"
    Then the command should succeed

  Scenario: workflow transition list resolves --workflow short ID
    Given a workflow "tlist-wf" with steps "one, two"
    And I store the workflow short ID as "w"
    When I run vtb "workflow transition list --workflow-id <w>"
    Then the command should succeed

  Scenario: workflow transition delete resolves source and target workflow short IDs
    Given a workflow "tdelsrc-wf" with steps "one, two"
    And I store the workflow short ID as "src"
    And a second workflow "tdeldst-wf" with steps "alpha, beta"
    And I run vtb "workflow transition add <src> <second_workflow_id> --label approve"
    When I run vtb "workflow transition delete <src> <second_workflow_id>"
    Then the command should succeed

  # ============================================================
  # step add / list / show / update / delete
  # ============================================================

  Scenario: step add resolves --workflow short ID
    Given a workflow "sa-wf" with steps "first"
    And I store the workflow short ID as "w"
    When I run vtb "step add new-step --workflow <w>"
    Then the command should succeed

  Scenario: step add resolves --transition-to short ID
    Given a workflow "satr-wf" with steps "first, second"
    And I store the workflow short ID as "w"
    And I store the short ID of step "second" as "s2"
    When I run vtb "step add gateway --workflow <w> --transition-to <s2>"
    Then the command should succeed

  Scenario: step list resolves workflow short ID
    Given a workflow "sl-wf" with steps "one, two"
    And I store the workflow short ID as "w"
    When I run vtb "step list <w>"
    Then the command should succeed

  Scenario: step show resolves step short ID
    Given a workflow "ss-wf" with steps "alpha, beta"
    And I store the short ID of step "alpha" as "s"
    When I run vtb "step show <s>"
    Then the command should succeed
    And the output should contain "alpha"

  Scenario: step update resolves step short ID
    Given a workflow "su-wf" with steps "alpha, beta"
    And I store the short ID of step "alpha" as "s"
    When I run vtb "step update <s> --goal Updated-goal"
    Then the command should succeed

  Scenario: step update resolves --transition-to short ID
    Given a workflow "sut-wf" with steps "alpha, beta, gamma"
    And I store the short ID of step "alpha" as "s_alpha"
    And I store the short ID of step "gamma" as "s_gamma"
    When I run vtb "step update <s_alpha> --transition-to <s_gamma>"
    Then the command should succeed

  Scenario: step delete resolves step short ID
    Given a workflow "sd-wf" with steps "alpha, beta, gamma"
    And I store the short ID of step "beta" as "s"
    When I run vtb "step delete <s>"
    Then the command should succeed

  # ============================================================
  # execution create / list (regression sites)
  # ============================================================

  Scenario: execution create resolves task short ID (regression)
    Given a workflow "exc-wf" with steps "alpha, beta"
    And I create a task with:
      | title | Exec target |
    And I assign the workflow to the task
    And I store the task short ID as "s"
    When I run vtb "execution create <s>"
    Then the error should not contain "is not a valid UUID or short ID"
    And the error should not contain "task ID"

  Scenario: execution list resolves task short ID (regression)
    Given a workflow "exl-wf" with steps "alpha, beta"
    And I create a task with:
      | title | Exec list target |
    And I assign the workflow to the task
    And I store the task short ID as "s"
    When I run vtb "execution list <s>"
    Then the command should succeed

  # ============================================================
  # Negative scenarios — unknown 8-char prefix
  # ============================================================

  Scenario: show with unknown short ID returns clear not-found error
    When I run vtb "show deadbeef"
    Then the command should fail with "not found"
    And the error should not contain "is not a valid UUID or short ID"

  Scenario: workflow show with unknown short ID returns clear not-found error
    When I run vtb "workflow show deadbeef"
    Then the command should fail with "not found"
    And the error should not contain "is not a valid UUID or short ID"
