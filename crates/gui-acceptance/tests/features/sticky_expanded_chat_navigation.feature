Feature: Sticky expanded chat navigation
  Expanded chat can be suspended while navigating the app and resumed without
  losing the active conversation.

  Scenario: Selecting the current page suspends expanded chat and the rail resumes it
    Given the GUI is showing the task list
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "New Chat" within 5 seconds
    When I expand the chat workspace
    And I press the "Meta+1" key
    Then the GUI should show an element with test id "sidebar-nav-chat" within 5 seconds
    And the GUI should not show an element with test id "chat-tabs-expand" within 5 seconds
    When I click on the element with test id "sidebar-nav-chat"
    Then the GUI should show a button labelled "Collapse chat workspace" within 5 seconds
    And the URL should contain "/tasks"
