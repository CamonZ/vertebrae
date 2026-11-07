@selection_discussions
Feature: Discuss code beside the main conversation
  Scenario: Passive real-renderer selection preserves the main conversation and dirty documents
    Given a Changes selection fixture is open beside a drafted main conversation
    When I exercise click drag shift-click and keyboard diff selections
    Then selection alone opens no editor and sends no model request
    And the main draft and conversation scroll are preserved
    When I edit the selected file and try to close Changes
    Then unsaved document protection keeps Changes open

  Scenario: Ask and follow up in an anchored read-only discussion
    Given a Changes selection fixture is open beside a drafted main conversation
    When I select fixture code with the real diff renderer
    And I ask about that selection and follow up
    Then both discussion requests contain the original selected code
    When I close and reopen the discussion through its diff marker
    Then the anchored discussion and main draft are preserved

  Scenario: Attach code and explicitly send it to the main conversation
    Given a Changes selection fixture is open beside a drafted main conversation
    When I select fixture code with the real diff renderer
    And I attach the selection to the main composer
    Then attachment alone sends no model request
    When I explicitly send the main draft
    Then the main request contains the selected code and question

  Scenario: Dedicated inline model survives reload and leaves the main conversation unchanged
    Given inline discussions use a dedicated model selected in Settings
    And a Changes selection fixture is open beside a drafted main conversation
    When I select fixture code with the real diff renderer
    And I ask about that selection and follow up
    Then both discussion requests contain the original selected code
    And inline requests use the dedicated model disclosed before submission
    When I explicitly send the main draft
    Then the main conversation still uses its original model
