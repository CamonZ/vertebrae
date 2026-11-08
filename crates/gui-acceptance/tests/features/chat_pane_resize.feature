Feature: Split chat pane resizing
  Scenario: Shared boundaries resize adjacent conversations in the real webview
    Given the GUI is showing the task list
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "New Chat" within 5 seconds
    And split chat boundaries preserve real geometry and keyboard resizing
