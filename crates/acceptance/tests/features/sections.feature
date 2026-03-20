Feature: Sections and checklist items
  Add, list, and remove typed content sections. Check and uncheck checklist items.

  Background:
    Given a configured Sacrum client
    And I create a task with:
      | title | Section test task |

  # --- section (add) ---

  Scenario: Add single-instance section (goal)
    When I add a "goal" section with content "Achieve X"
    Then the output should match "Added goal section to task: <TASK_ID>"
    And the task should have a goal section with content "Achieve X"

  Scenario: Replace single-instance section (goal)
    When I add a "goal" section with content "Original"
    And I add a "goal" section with content "Replaced"
    Then the output should match "Replaced goal section for task: <TASK_ID>"
    And the task should have 1 goal sections
    And the section "goal" content should be "Replaced"

  Scenario: Add multi-instance sections with auto ordinals
    When I add a "checklist_item" section with content "First"
    And I add a "checklist_item" section with content "Second"
    And I add a "checklist_item" section with content "Third"
    Then the output should match "Added checklist_item section (ordinal 2) to task: <TASK_ID>"
    And the task should have 3 checklist_item sections

  Scenario Outline: Add each section type
    When I add a "<type>" section with content "Test content"
    Then the task should have a <type> section

    Examples:
      | type              |
      | goal              |
      | context           |
      | current_behavior  |
      | desired_behavior  |
      | checklist_item    |
      | testing_criterion |
      | anti_pattern      |
      | failure_test      |
      | constraint        |

  Scenario: Empty content is rejected
    When I add a "goal" section with content ""
    Then the command should fail with "Validation failed: section content cannot be empty"

  Scenario: Whitespace content is rejected
    When I add a "goal" section with content "   "
    Then the command should fail with "Validation failed: section content cannot be empty"

  # --- sections (list) ---

  Scenario: List sections when empty
    When I list sections
    Then the output should match "No sections defined"

  Scenario: List sections with type filter when empty
    When I add a "goal" section with content "A goal"
    And I list sections with --type "testing_criterion"
    Then the output should match "No sections of type 'testing_criterion'"

  Scenario: List sections groups by positive/negative space
    When I add a "goal" section with content "The goal"
    And I add a "constraint" section with content "A constraint"
    And I list sections
    Then the output should contain "Desired Behavior"
    And the output should contain "Undesired Behavior"

  # --- unsection (remove) ---

  Scenario: Remove single-instance section
    When I add a "goal" section with content "To remove"
    And I remove the "goal" section
    Then the output should match "Removed goal section from task: <TASK_ID>"
    And the task should have 0 goal sections

  Scenario: Remove multi-instance section by index
    When I add a "checklist_item" section with content "Keep"
    And I add a "checklist_item" section with content "Remove"
    And I add a "checklist_item" section with content "Keep too"
    And I remove the "checklist_item" section at index 1
    Then the output should match "Removed checklist_item section from task: <TASK_ID>"
    And the task should have 2 checklist_item sections

  Scenario: Multi-instance without index is rejected
    When I add a "checklist_item" section with content "Item"
    And I remove the "checklist_item" section without index
    Then the command should fail with "Validation failed: Section type 'checklist_item' can have multiple instances. Use --index <n> to remove a specific one"

  Scenario: Remove at non-existent index is rejected
    When I add a "checklist_item" section with content "Only item"
    And I remove the "checklist_item" section at index 5
    Then the command should fail with "Validation failed: No checklist_item section found at index 5"

  Scenario: Remove non-existent single-instance is rejected
    When I remove the "goal" section
    Then the command should fail with "Validation failed: No goal section found"

  # --- check-item ---

  Scenario: Mark checklist item as done
    When I add a "checklist_item" section with content "Do the thing"
    And I check item 1
    Then the output should match "Marked checklist item 1 as done in <TASK_ID>: Do the thing"

  Scenario: Check specific item among multiple
    When I add a "checklist_item" section with content "First"
    And I add a "checklist_item" section with content "Second"
    And I add a "checklist_item" section with content "Third"
    And I check item 2
    Then the output should match "Marked checklist item 2 as done in <TASK_ID>: Second"
    And checklist item 1 should not be done
    And checklist item 3 should not be done

  Scenario: Index 0 is rejected
    When I add a "checklist_item" section with content "Item"
    And I check item 0
    Then the command should fail with "Validation failed: Checklist item index must be 1 or greater"

  Scenario: Out-of-bounds index is rejected
    When I add a "checklist_item" section with content "Only item"
    And I check item 5
    Then the command should fail with "Validation failed: Checklist item 5 not found. Task has 1 checklist item(s)."

  Scenario: Check on task with no checklist items
    When I check item 1
    Then the command should fail with "Validation failed: Checklist item 1 not found. Task has 0 checklist item(s)."

  # --- uncheck-item ---

  Scenario: Uncheck a checked item
    When I add a "checklist_item" section with content "Toggle me"
    And I check item 1
    And I uncheck item 1
    Then the output should match "Unchecked checklist item 1 in <TASK_ID>: Toggle me"
    And checklist item 1 should not be done

  Scenario: Uncheck an already unchecked item is rejected
    When I add a "checklist_item" section with content "Not checked"
    And I uncheck item 1
    Then the command should fail with "Validation failed: Checklist item 1 is not checked"
