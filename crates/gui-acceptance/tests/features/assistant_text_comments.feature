Feature: Comments on selected local chat response text
  Users can quote completed assistant prose, edit or remove pending comments,
  then submit comments alone or together with a normal follow-up.

  Scenario: Queue, edit, remove, and send selected-text comments
    Given the GUI is showing the task list
    When I configure the mock local chat reply as "First paragraph has a key phrase. It also explains the result.\n\nSecond paragraph adds context."
    And I click on the element with test id "local-chat-launcher"
    And I type "Start the comments acceptance conversation" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show "First paragraph has a key phrase." within 10 seconds
    And the local chat should show 1 completed assistant responses within 5 seconds

    When I select "key phrase" from a completed local chat response
    Then the local chat selection action should be visible above the panel within 5 seconds
    When I click on the element with test id "local-chat-add-comment"
    And I type "Explain this wording." into the element with test id "local-chat-comment-draft"
    And I click on the element with test id "local-chat-save-comment"
    Then the GUI should show exactly 1 elements with test id "local-chat-pending-comment" within 5 seconds
    When I hover over the element with test id "local-chat-comment-icon-1"
    Then the GUI element with test id "local-chat-comment-popover" should contain text "First paragraph has a key phrase. It also explains" within 5 seconds
    And the GUI element with test id "local-chat-comment-popover" should contain text "Explain this wording." within 5 seconds
    When I click on the element with test id "local-chat-comment-icon-1"

    When I click on the element with title "Edit comment 1"
    And I clear text in the element with test id "local-chat-comment-editor"
    And I type "Please explain the key phrase." into the element with test id "local-chat-comment-editor"
    And I click on the element with test id "local-chat-save-edited-comment"
    Then the GUI element with test id "local-chat-comment-popover" should contain text "Please explain the key phrase." within 5 seconds

    When I select the first paragraph of the latest completed local chat response
    And I click on the element with test id "local-chat-add-comment"
    And I type "This one will be removed." into the element with test id "local-chat-comment-draft"
    And I click on the element with test id "local-chat-save-comment"
    Then the GUI should show exactly 2 elements with test id "local-chat-pending-comment" within 5 seconds
    When I hover over the element with test id "local-chat-comment-icon-2"
    Then the GUI element with test id "local-chat-comment-popover" should contain text "This one will be removed." within 5 seconds
    When I click on the element with title "Remove comment 2"
    Then the GUI should show exactly 1 elements with test id "local-chat-pending-comment" within 5 seconds

    When I click on the element with title "Send message"
    Then the GUI should not show an element with test id "local-chat-pending-comments" within 5 seconds
    And the latest local chat user message should contain "key phrase" within 5 seconds
    And the latest local chat user message should contain "Please explain the key phrase." within 5 seconds
    And the local chat should show 2 completed assistant responses within 10 seconds

    When I select the first paragraph of the latest completed local chat response
    And I click on the element with test id "local-chat-add-comment"
    And I type "Clarify the result in this paragraph." into the element with test id "local-chat-comment-draft"
    And I click on the element with test id "local-chat-save-comment"
    Then the GUI should show exactly 1 elements with test id "local-chat-pending-comment" within 5 seconds
    And I type "Also check the tests." into the element with test id "local-chat-composer"
    And I click on the element with title "Send message"
    Then the GUI should not show an element with test id "local-chat-pending-comments" within 5 seconds
    And the latest local chat user message should contain "First paragraph has a key phrase." within 5 seconds
    And the latest local chat user message should contain "Clarify the result in this paragraph." within 5 seconds
    And the latest local chat user message should contain "Also check the tests." within 5 seconds
    And the local chat should show 3 completed assistant responses within 10 seconds
