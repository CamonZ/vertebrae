Feature: Local project chat lifecycle
  The project-scoped local chat should stream through the Tauri Claude IPC
  boundary and preserve its local transcript when the panel is closed and
  reopened.

  Scenario: Project chat streams and reopens the local transcript
    Given the GUI is showing the task list
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "New Chat" within 5 seconds
    When I type "hello from acceptance" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show "local-chat-acceptance reply" within 10 seconds
    And the GUI should not show an element with test id "chat-lifecycle-label" within 5 seconds
    When I click on the element with title "Close chat panel"
    Then the GUI should show an element with test id "local-chat-launcher" within 5 seconds
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "local-chat-acceptance reply" within 5 seconds
    And the GUI should not show an element with test id "chat-lifecycle-label" within 5 seconds
    When I click on the element with title "Toggle chat history"
    Then the GUI should show an element with test id "local-chat-history-drawer" within 5 seconds
    And the local chat history drawer should show the active project within 5 seconds
    And the GUI should show "local-chat-acceptance reply" within 5 seconds
    When I click on the element with title "Start fresh local chat"
    Then the GUI should not show "local-chat-acceptance reply" within 5 seconds
    And I click on the inactive local chat row with title "Open local chat New Chat"
    Then the GUI should show "local-chat-acceptance reply" within 5 seconds
    And I click on the active local chat row with title "Delete local chat New Chat"
    Then the GUI should not show "local-chat-acceptance reply" within 5 seconds

  Scenario: Project chat displays its inferred title
    Given the GUI is showing the task list
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "New Chat" within 5 seconds
    When I type "Review the latest pull request" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show "Local Chat Acceptance" within 10 seconds
