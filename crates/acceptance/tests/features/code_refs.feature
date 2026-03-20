Feature: Code references
  Add, list, and remove code references on tasks. Link references to testing criteria.

  Background:
    Given a configured Sacrum client
    And I create a task with:
      | title | Code ref test task |

  # --- ref (add) ---

  Scenario: Add file-only reference
    When I add a ref "src/main.rs"
    Then the output should match "Added reference src/main.rs to task: <TASK_ID>"

  Scenario: Add file with single line
    When I add a ref "src/lib.rs:L42"
    Then the output should match "Added reference src/lib.rs:L42 to task: <TASK_ID>"
    And the ref should have path "src/lib.rs" and line_start 42

  Scenario: Add file with line range
    When I add a ref "src/cmd.rs:L100-150"
    Then the output should match "Added reference src/cmd.rs:L100-150 to task: <TASK_ID>"
    And the ref should have path "src/cmd.rs" and line_start 100 and line_end 150

  Scenario: Add ref with name
    When I add a ref "src/utils.rs:L10" with:
      | name | parse_input |
    Then the output should contain "[parse_input]"

  Scenario: Add ref with description
    When I add a ref "src/api.rs" with:
      | description | Main handler |
    Then the ref should have description "Main handler"

  Scenario: File does not exist shows warning
    When I add a ref "nonexistent/file.rs"
    Then the output should contain "Warning: file 'nonexistent/file.rs' does not exist"

  Scenario: Invalid line range (start > end) is rejected
    When I add a ref "src/main.rs:L50-40"
    Then the command should fail with "Validation failed: src/main.rs:L50-40: invalid line range: start (50) > end (40)"

  Scenario: Empty line after L is rejected
    When I add a ref "src/main.rs:L"
    Then the command should fail with "Validation failed: src/main.rs:L: line number required after 'L'"

  Scenario: Invalid line number is rejected
    When I add a ref "src/main.rs:Labc"
    Then the command should fail with "Validation failed: src/main.rs:Labc: invalid line number: 'abc'"

  Scenario: Case-insensitive L in file spec
    When I add a ref "src/main.rs:l100"
    Then the ref should have path "src/main.rs" and line_start 100

  # --- refs (list) ---

  Scenario: List refs when empty
    When I list refs
    Then the output should match "No code references defined"

  Scenario: List refs shows table
    When I add a ref "src/main.rs:L10" with:
      | name | entry |
    And I add a ref "src/lib.rs"
    And I list refs
    Then the output should contain "Code references for: <TASK_ID>"
    And the output should contain "src/main.rs"
    And the output should contain "src/lib.rs"
    And the output should contain "L10"
    And the output should contain "entry"

  Scenario: Refs sorted by path then line number
    When I add a ref "src/z.rs:L50"
    And I add a ref "src/a.rs:L100"
    And I add a ref "src/a.rs:L10"
    And I list refs
    Then the refs should appear in order: "src/a.rs:L10", "src/a.rs:L100", "src/z.rs:L50"

  # --- unref (remove) ---

  Scenario: Remove refs by file path
    When I add a ref "src/main.rs:L10"
    And I add a ref "src/main.rs:L50"
    And I add a ref "src/lib.rs"
    And I unref "src/main.rs"
    Then the output should match "Removed 2 reference(s) to src/main.rs from task: <TASK_ID>"
    And the task should have 1 refs

  Scenario: Remove all refs
    When I add a ref "src/main.rs"
    And I add a ref "src/lib.rs"
    And I unref --all
    Then the output should match "Removed all 2 reference(s) from task: <TASK_ID>"
    And the task should have 0 refs

  Scenario: Unref file with no matches warns
    When I add a ref "src/main.rs"
    And I unref "src/other.rs"
    Then the output should match "Warning: No references to src/other.rs in task: <TASK_ID>"

  Scenario: Unref --all with no refs
    When I unref --all
    Then the output should match "No references to remove from task: <TASK_ID>"

  # --- criterion-ref ---

  Scenario: Add ref to testing criterion
    When I add a "testing_criterion" section with content "Verify output"
    And I add a criterion-ref 1 "tests/test.rs:L42"
    Then the output should contain "Added reference tests/test.rs:L42 to testing criterion 1"
    And the output should contain "Verify output"

  Scenario: Add ref to second criterion
    When I add a "testing_criterion" section with content "First criterion"
    And I add a "testing_criterion" section with content "Second criterion"
    And I add a criterion-ref 2 "tests/second.rs"
    Then the output should contain "testing criterion 2"
    And the output should contain "Second criterion"

  Scenario: Criterion-ref with name
    When I add a "testing_criterion" section with content "Test it"
    And I add a criterion-ref 1 "tests/test.rs:L10" with:
      | name | test_fn |
    Then the output should contain "[test_fn]"

  Scenario: Criterion-ref index 0 is rejected
    When I add a "testing_criterion" section with content "Test"
    And I add a criterion-ref 0 "tests/test.rs"
    Then the command should fail with "Validation failed: Testing criterion index must be 1 or greater"

  Scenario: Criterion-ref out of bounds is rejected
    When I add a "testing_criterion" section with content "Only one"
    And I add a criterion-ref 2 "tests/test.rs"
    Then the command should fail with "Validation failed: Testing criterion at index 2 not found. Task has 1 testing criterion(s)."

  Scenario: Criterion-ref on task with no criteria
    When I add a criterion-ref 1 "tests/test.rs"
    Then the command should fail with "Validation failed: Testing criterion at index 1 not found. Task has 0 testing criterion(s)."
