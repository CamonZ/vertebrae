Feature: Task dependencies
  Create and remove dependency relationships, find blockers and paths.

  Background:
    Given a configured Sacrum client

  # --- depend ---

  Scenario: Create dependency between two tasks
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    When I run depend "<a>" --on "<b>"
    Then the output should match "Created dependency: <a> depends on <b>"

  Scenario: Depend is idempotent
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    And I run depend "<a>" --on "<b>"
    When I run depend "<a>" --on "<b>"
    Then the output should match "Dependency already exists: <a> -> <b>"

  Scenario: Self-dependency is rejected
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    When I run depend "<a>" --on "<a>"
    Then the command should fail with "Validation failed: Task cannot depend on itself"

  Scenario: Cyclic dependency is rejected
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    And I run depend "<a>" --on "<b>"
    When I run depend "<b>" --on "<a>"
    Then the command should fail with "Dependency would create a cycle"
    And the hint should contain "circular dependency chain"

  Scenario: Indirect cycle is rejected
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    And I create a task with:
      | title | Task C |
    And I store the task ID as "c"
    And I run depend "<a>" --on "<b>"
    And I run depend "<b>" --on "<c>"
    When I run depend "<c>" --on "<a>"
    Then the command should fail with "Dependency would create a cycle"

  Scenario: Depend on non-existent task fails
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    When I run depend "<a>" --on "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "Task not found: 00000000-0000-4000-8000-000000000000"

  # --- undepend ---

  Scenario: Remove existing dependency
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    And I run depend "<a>" --on "<b>"
    When I run undepend "<a>" --on "<b>"
    Then the output should match "Removed dependency: <a> no longer depends on <b>"

  Scenario: Undepend on non-existent dependency warns
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    When I run undepend "<a>" --on "<b>"
    Then the output should match "Warning: No dependency from <a> to <b> exists"

  # --- blockers ---

  Scenario: No blockers
    Given I create a task with:
      | title | Independent |
    When I run blockers for the task
    Then the output should match "No blockers"

  Scenario: Direct blockers are listed
    Given I create a task with:
      | title | Blocker 1 |
    And I store the task ID as "b1"
    And I create a task with:
      | title | Blocker 2 |
    And I store the task ID as "b2"
    And I create a task with:
      | title | Blocked |
    And I store the task ID as "blocked"
    And I run depend "<blocked>" --on "<b1>"
    And I run depend "<blocked>" --on "<b2>"
    When I run blockers for task "<blocked>"
    Then the output should contain "Blockers for: <blocked>"
    And the output should contain "<b1>"
    And the output should contain "<b2>"
    And the output should contain "Total: 2 blocking items"

  Scenario: Recursive blocker chain
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    And I create a task with:
      | title | Task C |
    And I store the task ID as "c"
    And I run depend "<a>" --on "<b>"
    And I run depend "<b>" --on "<c>"
    When I run blockers for task "<a>"
    Then the output should contain "<b>"
    And the output should contain "<c>"
    And the output should contain "Total: 2 blocking items"

  Scenario: Depth limit truncates tree
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    And I create a task with:
      | title | Task C |
    And I store the task ID as "c"
    And I run depend "<a>" --on "<b>"
    And I run depend "<b>" --on "<c>"
    When I run blockers for task "<a>" with --depth 1
    Then the output should contain "<b>"
    And the output should not contain "<c>"
    And the output should contain "Total: 1 blocking item"

  # --- path ---

  Scenario: Direct dependency path
    Given I create a task with:
      | title | From |
    And I store the task ID as "from"
    And I create a task with:
      | title | To |
    And I store the task ID as "to"
    And I run depend "<from>" --on "<to>"
    When I run path "<from>" "<to>"
    Then the output should contain "Path from <from> to <to>:"
    And the output should contain "2 tasks in path"

  Scenario: Same task path
    Given I create a task with:
      | title | Same |
    And I store the task ID as "same"
    When I run path "<same>" "<same>"
    Then the output should contain "Same task:"

  Scenario: No path between unrelated tasks
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    When I run path "<a>" "<b>"
    Then the output should match "No dependency path from <a> to <b>"

  Scenario: Chain path
    Given I create a task with:
      | title | Task A |
    And I store the task ID as "a"
    And I create a task with:
      | title | Task B |
    And I store the task ID as "b"
    And I create a task with:
      | title | Task C |
    And I store the task ID as "c"
    And I run depend "<a>" --on "<b>"
    And I run depend "<b>" --on "<c>"
    When I run path "<a>" "<c>"
    Then the output should contain "3 tasks in path"

  Scenario: Path with non-existent task fails
    Given I create a task with:
      | title | Existing |
    And I store the task ID as "existing"
    When I run path "<existing>" "00000000-0000-4000-8000-000000000000"
    Then the command should fail with "Task not found: 00000000-0000-4000-8000-000000000000"
