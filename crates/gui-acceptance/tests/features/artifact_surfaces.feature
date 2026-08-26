Feature: Artifact GUI surfaces
  Project and task artifact projections are rendered from the real Sacrum API
  and converge through the active project's CDC connection.

  Scenario: Project artifacts render supported formats and raw fallbacks
    Given the GUI is showing project artifacts
    When I create project artifact "artifact-markdown.md" of kind "markdown" via the CLI
    And I create project artifact "artifact-data.json" of kind "json" via the CLI
    And I create project artifact "artifact-conversation.jsonl" of kind "conversation" via the CLI
    And I create project artifact "artifact-malformed.json" of kind "malformed-json" via the CLI
    And I create project artifact "artifact-unknown.yaml" of kind "unknown" via the CLI
    Then the GUI should show "artifact-markdown.md" within 10 seconds
    And the GUI should show "artifact-data.json" within 10 seconds
    And the GUI should show "artifact-conversation.jsonl" within 10 seconds
    When I click on the element containing text "artifact-markdown.md"
    Then the GUI should show "Artifact Markdown Heading" within 5 seconds
    When I click on the element containing text "artifact-data.json"
    Then the GUI should show "Artifact JSON Value" within 5 seconds
    When I click on the element containing text "artifact-conversation.jsonl"
    Then the GUI should show "Artifact conversation question" within 5 seconds
    And the GUI should show "Artifact conversation answer" within 5 seconds
    And the artifact preview has no composer
    When I click on the element containing text "artifact-malformed.json"
    Then the GUI should show "This artifact declares JSON content" within 5 seconds
    When I click on the element containing text "artifact-unknown.yaml"
    Then the GUI should show "Unsupported artifact presentation" within 5 seconds
    When I delete the current artifact via the CLI
    Then the GUI should not show "artifact-unknown.yaml" within 10 seconds

  Scenario: Project artifact paths render as an expandable tree with type badges
    Given the GUI is showing project artifacts
    When I create project artifact "tree-summary.md" with logical name "reports/summary.md" of kind "markdown" via the CLI
    And I create project artifact "tree-data.json" with logical name "reports/data.json" of kind "json" via the CLI
    Then the GUI should show "reports" within 10 seconds
    And the GUI should show "summary.md" within 10 seconds
    And the GUI should show an element with test id "tree-indent-guides" within 10 seconds
    And the artifact tree folder "reports" should be expanded within 10 seconds
    And the artifact tree leaf "summary.md" should show type badge "Markdown" within 10 seconds
    When I collapse the artifact tree folder "reports"
    Then the GUI should not show "summary.md" within 5 seconds
    When I expand the artifact tree folder "reports"
    Then the GUI should show "summary.md" within 5 seconds

  Scenario: A task attachment opens an adjacent read-only preview
    Given the GUI is showing the task list
    When I create a task "Artifact attachment task" via the CLI
    Then the GUI should show "Artifact attachment task" within 10 seconds
    When I click on the element containing text "Artifact attachment task"
    And I create a task artifact "task-attachment.md" of kind "markdown" via the CLI
    Then the GUI should show "task-attachment.md" within 10 seconds
    When I click on the element containing text "task-attachment.md"
    Then the GUI should show an element with test id "task-detail-panel" within 5 seconds
    And the GUI should show an element with test id "artifact-inspector-panel" within 5 seconds
    And the GUI should show "Artifact Markdown Heading" within 5 seconds
    When I click on the element with test id "artifact-inspector-close"
    Then the GUI should show an element with test id "task-detail-panel" within 5 seconds
