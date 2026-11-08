@statechart_artifacts
Feature: Published statechart artifact contract
  Scenario: The published definition and commands persist and render in real chat
    Given the GUI is showing the task list
    When I create a task with:
      | title | Statechart documentation ticket |
      | level | ticket                         |
    And I save and attach the published statechart example and configure its chat link
    And I click on the element with test id "local-chat-launcher"
    And I type "show the attached workflow" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show an element with test id "statechart-preview" within 15 seconds
    And the real chat statechart shows its hierarchy and transitions
