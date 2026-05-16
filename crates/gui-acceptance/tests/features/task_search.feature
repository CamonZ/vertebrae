Feature: Task search
  The Tasks page search box should use backend task search semantics.

  Scenario: Search tasks by title
    Given the GUI is showing the task list
    When I create a task with:
      | title | GUI Title Search Target |
    And I create a task with:
      | title | GUI Title Search Miss |
    And I type "GUI Title Search Target" into the element with test id "task-search-input"
    Then the GUI should show "GUI Title Search Target" within 10 seconds
    And the GUI should not show "GUI Title Search Miss" within 10 seconds

  Scenario: Search tasks by description
    Given the GUI is showing the task list
    When I create a task with:
      | title       | GUI Description Search Target |
      | description | GUI description needle         |
    And I create a task with:
      | title       | GUI Description Search Miss |
      | description | Unrelated description       |
    And I type "description needle" into the element with test id "task-search-input"
    Then the GUI should show "GUI Description Search Target" within 10 seconds
    And the GUI should not show "GUI Description Search Miss" within 10 seconds

  Scenario: Search tasks by full UUID
    Given the GUI is showing the task list
    When I create a task with:
      | title | GUI Full UUID Search Miss |
    And I create a task with:
      | title | GUI Full UUID Search Target |
    And I type the current task ID into the element with test id "task-search-input"
    Then the GUI should show "GUI Full UUID Search Target" within 10 seconds
    And the GUI should not show "GUI Full UUID Search Miss" within 10 seconds

  Scenario: Search tasks by UUID prefix
    Given the GUI is showing the task list
    When I create a task with:
      | title | GUI UUID Prefix Search Miss |
    And I create a task with:
      | title | GUI UUID Prefix Search Target |
    And I type the current task short ID into the element with test id "task-search-input"
    Then the GUI should show "GUI UUID Prefix Search Target" within 10 seconds
    And the GUI should not show "GUI UUID Prefix Search Miss" within 10 seconds

  Scenario: Search board tasks by title
    Given the GUI is on the kanban board
    When I create a task with:
      | title | GUI Board Title Search Target |
    And I create a task with:
      | title | GUI Board Title Search Miss |
    And I type "GUI Board Title Search Target" into the element with test id "board-task-search-input"
    Then the GUI should show "GUI Board Title Search Target" within 10 seconds
    And the GUI should not show "GUI Board Title Search Miss" within 10 seconds

  Scenario: Search board tasks by description
    Given the GUI is on the kanban board
    When I create a task with:
      | title       | GUI Board Description Search Target |
      | description | GUI board description needle         |
    And I create a task with:
      | title       | GUI Board Description Search Miss |
      | description | Unrelated board description       |
    And I type "board description needle" into the element with test id "board-task-search-input"
    Then the GUI should show "GUI Board Description Search Target" within 10 seconds
    And the GUI should not show "GUI Board Description Search Miss" within 10 seconds

  Scenario: Search board tasks by full UUID
    Given the GUI is on the kanban board
    When I create a task with:
      | title | GUI Board Full UUID Search Miss |
    And I create a task with:
      | title | GUI Board Full UUID Search Target |
    And I type the current task ID into the element with test id "board-task-search-input"
    Then the GUI should show "GUI Board Full UUID Search Target" within 10 seconds
    And the GUI should not show "GUI Board Full UUID Search Miss" within 10 seconds

  Scenario: Search board tasks by UUID prefix
    Given the GUI is on the kanban board
    When I create a task with:
      | title | GUI Board UUID Prefix Search Miss |
    And I create a task with:
      | title | GUI Board UUID Prefix Search Target |
    And I type the current task short ID into the element with test id "board-task-search-input"
    Then the GUI should show "GUI Board UUID Prefix Search Target" within 10 seconds
    And the GUI should not show "GUI Board UUID Prefix Search Miss" within 10 seconds
