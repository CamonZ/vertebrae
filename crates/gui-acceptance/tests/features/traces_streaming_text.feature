Feature: Traces page streams assistant text and reports usage
  The daemon publishes each harness text delta through Sacrum, which
  broadcasts it to the GUI without storing it and persists only the item's
  completed snapshot. The traces page must grow one assistant message while
  it streams, replace it with the snapshot without duplicating text, show
  the usage Sacrum rolled up for the execution, and show the final text
  exactly once after a reload from storage. After completion the thread
  folds an agent message that equals the step output into the output card,
  which applies to Codex, whose output is the agent's final text. Each scenario drives the full
  daemon → provider mock → Sacrum → GUI path for one harness.

  Scenario: Claude text deltas stream into one assistant message
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Claude Streaming Workflow |
    And I create a step "Claude Streaming Step" in the workflow "Claude Streaming Workflow" via the CLI
    And the step runs on the "claude" harness
    And the "claude" mock streams "stream-alpha", "stream-beta" and "stream-gamma" reporting 120 input, 300 cached and 45 output tokens
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Claude Streaming Task     |
      | workflow | Claude Streaming Workflow |
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the only assistant message should read "stream-alpha" within 30 seconds
    And the GUI should not show "stream-beta" within 1 seconds
    And the only assistant message should read "stream-alpha stream-beta stream-gamma" within 30 seconds
    When I wait up to 30 seconds for the task to have a completed execution
    Then the element with test id "traces-hero-tokens-raw" should read "120 raw" within 15 seconds
    And the element with test id "traces-hero-tokens-cache" should read "300 cache" within 15 seconds
    And the element with test id "traces-hero-tokens-output" should read "45 out" within 15 seconds
    And Sacrum stores the assistant text "stream-alpha stream-beta stream-gamma" once and no text deltas
    When I reload the traces page for the created task
    Then the conversation should show "stream-alpha stream-beta stream-gamma" exactly once within 15 seconds
    And the element with test id "traces-hero-tokens-cache" should read "300 cache" within 15 seconds

  Scenario: Codex text deltas stream into one assistant message
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Codex Streaming Workflow |
    And I create a step "Codex Streaming Step" in the workflow "Codex Streaming Workflow" via the CLI
    And the step runs on the "codex" harness
    And the "codex" mock streams "stream-alpha", "stream-beta" and "stream-gamma" reporting 220 input, 160 cached and 35 output tokens
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Codex Streaming Task     |
      | workflow | Codex Streaming Workflow |
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the only assistant message should read "stream-alpha" within 30 seconds
    And the GUI should not show "stream-beta" within 1 seconds
    And the only assistant message should read "stream-alpha stream-beta stream-gamma" within 30 seconds
    When I wait up to 30 seconds for the task to have a completed execution
    Then the element with test id "traces-hero-tokens-raw" should read "220 raw" within 15 seconds
    And the element with test id "traces-hero-tokens-cache" should read "160 cache" within 15 seconds
    And the element with test id "traces-hero-tokens-output" should read "35 out" within 15 seconds
    And Sacrum stores the assistant text "stream-alpha stream-beta stream-gamma" once and no text deltas
    When I reload the traces page for the created task
    Then the conversation should show "stream-alpha stream-beta stream-gamma" exactly once within 15 seconds
    And the element with test id "traces-hero-tokens-cache" should read "160 cache" within 15 seconds
