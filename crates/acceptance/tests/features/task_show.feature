Feature: Show task details
  Display full task information including metadata, sections, relationships, and code refs.

  Background:
    Given a configured Sacrum client

  Scenario: Show task displays metadata
    Given I create a task with:
      | title       | Show test task |
      | level       | ticket         |
      | description | Some details   |
      | priority    | critical       |
    When I show the task
    Then the output should contain "Task: <TASK_ID> - Show test task"
    And the output should contain "Level:    ticket"
    And the output should contain "Priority: critical"
    And the output should contain "Some details"

  Scenario: Show task displays parent relationship
    Given I create a task with:
      | title | Parent epic |
      | level | epic        |
    And I store the task ID as "parent_id"
    And I create a task with:
      | title  | Child task  |
      | parent | <parent_id> |
    When I show the task
    Then the output should contain "Parent: <parent_id>"

  Scenario: Show task displays children
    Given I create a task with:
      | title | Parent |
      | level | epic   |
    And I store the task ID as "parent_id"
    And I create a task with:
      | title  | Child A     |
      | parent | <parent_id> |
    And I store the task ID as "child_a"
    And I create a task with:
      | title  | Child B     |
      | parent | <parent_id> |
    And I store the task ID as "child_b"
    When I show the task "<parent_id>"
    Then the output should contain "Children:"
    And the output should contain "<child_a>"
    And the output should contain "<child_b>"

  Scenario: Show task displays blockers (filtered to incomplete)
    Given I create a task with:
      | title | Blocker |
    And I store the task ID as "blocker_id"
    And I create a task with:
      | title      | Blocked      |
      | depends_on | <blocker_id> |
    When I show the task
    Then the output should contain "Blocked by:"
    And the output should contain "<blocker_id>"

  Scenario: Show task keeps a blocker visible when a done-named step has no completion timestamp
    Given a workflow "nonterminal-show-wf" with steps "backlog, done"
    And I create a task with:
      | title | Nonterminal done blocker |
    And I assign the workflow to the task
    And I store the task ID as "blocker_id"
    And I create a task with:
      | title | Blocked by nonterminal done |
    And I store the task ID as "blocked_id"
    And I run depend "<blocked_id>" --on the lifecycle task
    When I transition the lifecycle task through to step "done" with --skip-validation
    And I show the task "<blocked_id>"
    Then the output should contain "Blocked by:"
    And the output should contain "<blocker_id>"

  Scenario: Show task hides a blocker after completed_at is set
    Given a workflow "terminal-show-wf" with steps "backlog, done"
    And the workflow is final
    And I create a task with:
      | title | Completed blocker |
    And I assign the workflow to the task
    And I store the task ID as "blocker_id"
    And I create a task with:
      | title | Blocked by completed task |
    And I store the task ID as "blocked_id"
    And I run depend "<blocked_id>" --on the lifecycle task
    When I transition the lifecycle task through to step "done" with --skip-validation
    And I show the task "<blocked_id>"
    Then the output should not contain "Blocked by:"
    And the output should not contain "<blocker_id>"

  Scenario: Show task displays sections
    Given I create a task with:
      | title | Section show task |
    When I add a "goal" section with content "Ship fast"
    And I add a "checklist_item" section with content "Write code"
    And I add a "checklist_item" section with content "Add tests"
    And I add a "constraint" section with content "No regressions"
    And I show the task
    Then the output should contain "Goal"
    And the output should contain "Ship fast"
    And the output should contain "Checklist Items"
    And the output should contain "Write code"
    And the output should contain "Add tests"
    And the output should contain "Constraints"
    And the output should contain "No regressions"

  Scenario: Show task displays code references
    Given I create a task with:
      | title | Ref show task |
    When I add a ref "src/main.rs:L42" with:
      | name | entry_point |
    And I add a ref "src/lib.rs:L10-20"
    And I show the task
    Then the output should contain "Code References"
    And the output should contain "src/main.rs"
    And the output should contain "[entry_point]"
    And the output should contain "src/lib.rs"

  Scenario: Show task displays checklist items with checkboxes
    Given I create a task with:
      | title | Checkbox show task |
    When I add a "checklist_item" section with content "Not done yet"
    And I add a "checklist_item" section with content "Already done"
    And I check item 2
    And I show the task
    Then the output should contain "Checklist Items"
    And the output should contain "[ ] Not done yet"
    And the output should contain "[x] Already done"

  Scenario: Show task displays timestamps
    Given I create a task with:
      | title | Timestamp task |
    When I show the task
    Then the output should contain "Started At:"
    And the output should contain "Updated At:"
    And the output should contain "Completed At:"

  Scenario: Show non-existent task fails
    When I show the task "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "Task not found:"
    And the hint should contain "Use 'vtb list' to see available tasks"
