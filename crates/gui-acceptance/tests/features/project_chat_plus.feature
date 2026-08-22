Feature: Project chat plus actions
  Project-group plus actions must target the group's captured directory and
  focus the resulting session without losing other project conversations.

  @multi_project
  Scenario: Claude project plus actions focus each project's active chat
    Given the GUI is showing the task list
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "New Chat" within 5 seconds
    When I click on the element with title "Close chat panel"
    And I switch to the second project
    And I click on the element with test id "local-chat-launcher"
    Then the GUI should show "New Chat" within 5 seconds
    When I click on the element with title "Toggle chat history"
    Then the local chat history drawer should show the active project within 5 seconds
    When I click the local chat plus action for the "primary" project
    Then the active local chat should use the "primary" project directory within 5 seconds
    When I click the local chat plus action for the "second" project
    Then the active local chat should use the "second" project directory within 5 seconds

  Scenario: Codex project plus action keeps the selected project active
    Given the GUI is showing the task list
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "New Chat" within 5 seconds
    When I click on the element with title "Toggle chat history"
    And I click the local chat plus action for the "primary" project
    Then the active local chat should use the "primary" project directory within 5 seconds
    When I choose local chat provider "codex"
    Then the local chat provider should be "codex" within 5 seconds
