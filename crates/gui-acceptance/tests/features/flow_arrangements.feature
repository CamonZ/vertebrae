@flow_arrangements
Feature: Named arrangements in a real chat flow diagram
  An assistant reply with a three-option flow spec renders a player whose
  selector lists every arrangement. Switching by pointer or by key keeps the
  beat and the pinned part, and parts stay where they are.

  Scenario: The three-option reference spec compares its options in real chat
    Given the GUI is showing the task list
    When I configure the mock local chat reply as the three-option flow spec
    And I click on the element with test id "local-chat-launcher"
    And I type "compare the burst options" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show an element with test id "flow-player" within 15 seconds
    And the real chat flow player switches between the three options by pointer and key
