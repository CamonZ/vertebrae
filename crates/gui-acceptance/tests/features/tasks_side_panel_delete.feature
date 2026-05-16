Feature: Tasks side panel deletion
  Tasks can be deleted from the Tasks page side-panel detail view.

  Scenario: Delete a task through the Tasks side-panel button
    Given the GUI is showing the task list
    When I create a task "Side Panel Task To Delete" via the CLI
    Then the GUI should show "Side Panel Task To Delete" within 10 seconds
    When I click on the element containing text "Side Panel Task To Delete"
    Then the GUI should show "Delete" within 5 seconds
    When I click on the element with test id "task-detail-delete-button"
    Then the GUI should show an element with test id "task-delete-confirmation" within 5 seconds
    And the GUI element with test id "task-delete-confirmation" should contain text "Delete Task?" within 5 seconds
    When I click on the element containing text "Confirm Delete"
    Then the GUI should not show "Side Panel Task To Delete" within 10 seconds
