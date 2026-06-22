Feature: Local project chat lifecycle
  The project-scoped local chat should stream through the Tauri Claude IPC
  boundary and preserve its local transcript when the panel is closed and
  reopened.

  Scenario: Project chat streams and reopens the local transcript
    Given the GUI is showing the task list
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "Project Chat" within 5 seconds
    When I type "hello from acceptance" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show "local-chat-acceptance reply" within 10 seconds
    And the GUI element with test id "chat-lifecycle-label" should contain text "Resumable" within 10 seconds
    When I click on the element with title "Close chat panel"
    Then the GUI should show an element with test id "local-chat-launcher" within 5 seconds
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "local-chat-acceptance reply" within 5 seconds
    And the GUI element with test id "chat-lifecycle-label" should contain text "Resumable" within 5 seconds
