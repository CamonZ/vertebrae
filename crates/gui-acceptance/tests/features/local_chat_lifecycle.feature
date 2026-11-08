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
    And the GUI should show "Local Chat Acceptance" within 10 seconds
    When I click on the element with title "Close chat panel"
    Then the GUI should show an element with test id "local-chat-launcher" within 5 seconds
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "local-chat-acceptance reply" within 5 seconds
    And the GUI should not show an element with test id "chat-lifecycle-label" within 5 seconds
    When I click on the element with title "Toggle chat history"
    Then the GUI should show an element with test id "local-chat-history-drawer" within 5 seconds
    And the local chat history drawer should show the "primary" project within 5 seconds
    And the GUI should show "local-chat-acceptance reply" within 5 seconds
    When I click on the element with title "Start fresh local chat"
    Then the GUI should not show "local-chat-acceptance reply" within 5 seconds
    When I click on the inactive local chat row with title "Open local chat Local Chat Acceptance"
    Then the GUI should show "local-chat-acceptance reply" within 5 seconds
    When I click on the active local chat row with title "Delete local chat Local Chat Acceptance"
    Then the GUI should not show "local-chat-acceptance reply" within 5 seconds

  Scenario: Project chat displays its inferred title
    Given the GUI is showing the task list
    When I click on the element with test id "local-chat-launcher"
    Then the GUI should show "New Chat" within 5 seconds
    When I type "Review the latest pull request" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show "Local Chat Acceptance" within 10 seconds

  Scenario: A single child conversation retains parents without direct conversations
    Given the GUI is showing the task list
    And the following entity conversations exist:
      | entity | level  | parent | chat       | completed |
      | Epic   | epic   | -      | -          | no        |
      | Ticket | ticket | Epic   | -          | no        |
      | Task   | task   | Ticket | Task chat  | no        |
    When I open the entity conversation browser
    Then the conversation browser should contain this hierarchy:
      | path                 | chats     |
      | Epic                 | -         |
      | Epic / Ticket        | -         |
      | Epic / Ticket / Task | Task chat |

  Scenario: Siblings and nested children precede every direct parent conversation
    Given the GUI is showing the task list
    And the following entity conversations exist:
      | entity  | level  | parent | chat         | completed |
      | Epic    | epic   | -      | Epic chat    | no        |
      | Ticket  | ticket | Epic   | Ticket chat  | no        |
      | Task    | task   | Ticket | Task chat    | no        |
      | Sibling | ticket | Epic   | Sibling chat | no        |
      | Alone   | ticket | -      | Parent only  | no        |
    When I open the entity conversation browser
    Then the conversation browser should contain this hierarchy:
      | path                 | chats        |
      | Alone                | Parent only  |
      | Epic                 | Epic chat    |
      | Epic / Sibling       | Sibling chat |
      | Epic / Ticket        | Ticket chat  |
      | Epic / Ticket / Task | Task chat    |

  Scenario: Completed filtering prunes empty branches and keeps visible descendants
    Given the GUI is showing the task list
    And the following entity conversations exist:
      | entity  | level  | parent | chat         | completed |
      | Epic    | epic   | -      | -            | no        |
      | Ticket  | ticket | Epic   | Ticket chat  | yes       |
      | Task    | task   | Ticket | Task chat    | no        |
      | Sibling | ticket | Epic   | Sibling chat | yes       |
      | Done    | task   | -      | Done chat    | yes       |
      | -       | -      | -      | General chat | no        |
    When I open the entity conversation browser
    Then the conversation browser should contain this hierarchy:
      | path                 | chats        |
      | Epic                 | -            |
      | Epic / Ticket        | -            |
      | Epic / Ticket / Task | Task chat    |
      | Other chats          | General chat |
    When I toggle completed entity conversations
    Then the conversation browser should contain this hierarchy:
      | path                 | chats        |
      | Done                 | Done chat    |
      | Epic                 | -            |
      | Epic / Sibling       | Sibling chat |
      | Epic / Ticket        | Ticket chat  |
      | Epic / Ticket / Task | Task chat    |
      | Other chats          | General chat |
    When I toggle completed entity conversations
    Then the conversation browser should contain this hierarchy:
      | path                 | chats        |
      | Epic                 | -            |
      | Epic / Ticket        | -            |
      | Epic / Ticket / Task | Task chat    |
      | Other chats          | General chat |
