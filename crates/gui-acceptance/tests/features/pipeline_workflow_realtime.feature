Feature: Real-time workflow rendering on pipeline view
  When a workflow is created via the CLI, it should appear in the
  pipeline view in real-time without requiring a page reload.

  Scenario: Workflow created via CLI appears in pipeline view
    Given the GUI is on the pipeline view
    When I create a workflow "Pipeline Workflow Test" via the CLI
    Then the GUI should show "Pipeline Workflow Test" within 10 seconds
