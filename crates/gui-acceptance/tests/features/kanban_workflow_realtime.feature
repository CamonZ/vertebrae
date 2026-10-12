Feature: Real-time workflow rendering on kanban board
  When a workflow is created via the CLI with a kanban column, the column
  should appear on the kanban board in real-time without requiring a page reload.

  Scenario: Workflow created via CLI appears as kanban column
    Given I create a workflow with:
      | name          | KWT Seed Workflow |
      | kanban_column | KWT Seed Column   |
    And the GUI is on the kanban board
    When I create a workflow with:
      | name          | Kanban Workflow Test |
      | kanban_column | KWT Board Column     |
    Then the GUI should show "KWT Board Column" within 10 seconds
