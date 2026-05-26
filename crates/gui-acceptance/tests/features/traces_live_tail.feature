Feature: Traces THREAD mode polish — live-tail and shared filters
  After opening /traces/:taskId, the polish layer must surface a shared
  FilterBar (status / step / model / search / Root only), an auto-scroll
  toggle for THREAD live-tailing, and apply filters consistently across
  THREAD, FLIGHT-STRIP and CORRIDOR modes. Live-tail behavior must keep
  appending new SessionLog events into the unified chat as a step
  execution is updated mid-view.

  # TODO: covered by vitest TracesPage.polish.test.tsx; acceptance harness
  # lacks a way to emit a SessionLog event mid-scenario, so the live-tail
  # mid-view scroll/append behavior is not exercised here.

  Background:
    Given I create a workflow with:
      | name | Live Tail Workflow |
    And I create a step "Live Tail Step" in the workflow "Live Tail Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Live Tail Root Task |
      | workflow | Live Tail Workflow  |
    Then the GUI should show "Live Tail Root Task" within 10 seconds
    When I click on the element containing text "Live Tail Root Task"
    Then the GUI should show "Live Tail Root Task" within 5 seconds
    When I click on the element with test id "trace-mini-explore"
    Then the GUI should show "Σ Runs" within 10 seconds
    And the GUI should show an element with test id "trace-filter-bar" within 10 seconds

  Scenario: Filter bar and auto-scroll toggle render alongside the unified chat
    Then the GUI should show an element with test id "trace-filter-status" within 5 seconds
    And the GUI should show an element with test id "trace-filter-step" within 5 seconds
    And the GUI should show an element with test id "trace-filter-model" within 5 seconds
    And the GUI should show an element with test id "trace-filter-search" within 5 seconds
    And the GUI should show an element with test id "trace-filter-root-only" within 5 seconds
    And the GUI should show an element with test id "traces-auto-scroll" within 5 seconds
    And the GUI should show an element with test id "unified-chat-view" within 10 seconds

  Scenario: Typing into the search box pushes the query into the URL
    When I type "zzznoexec" into the element with test id "trace-filter-search"
    Then the URL should contain "q=zzznoexec"

  Scenario: Toggling Root-only updates the URL query string
    When I click on the element with test id "trace-filter-root-only"
    Then the URL should contain "rootOnly=1"

  Scenario: Pressing slash focuses the trace search input
    When I press the "slash" key
    Then the focused element has test id "trace-filter-search"

  # The deep-link via #exec=<id> scenario was considered but dropped: the
  # acceptance flow does not expose the dynamic root task id to subsequent
  # steps, so we cannot reliably build a /traces/<id>#exec=anything URL
  # from the feature file. The hash-parsing behavior is covered by
  # TracesPage.polish.test.tsx in the vitest suite.
