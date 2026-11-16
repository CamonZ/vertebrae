Feature: Real-time step rendering on pipeline view
  When a step is added to a workflow via the CLI, it should appear
  in the pipeline view in real-time without requiring a page reload.

  Scenario: Step created via CLI appears in pipeline view
    Given the GUI is on the pipeline view
    And a workflow "Step Pipeline Workflow" exists via the CLI
    And I select factory "No Factory"
    Then the GUI should show an element with test id "workflow-station-Step Pipeline Workflow" within 10 seconds
    When I open workflow "Step Pipeline Workflow" in the Graph
    When I create a step "Review Code" in the workflow "Step Pipeline Workflow" via the CLI
    Then the GUI should show an element with test id "step-node-Review Code" within 10 seconds
