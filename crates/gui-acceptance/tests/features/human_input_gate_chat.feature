Feature: Resolve a human_input gate in a local chat
  A TaskRun waiting at a human_input gate offers Resolve. Resolve opens a
  local chat bound to the gate: the harness starts with hidden instructions
  carrying the gate's question, schema and exact submit command, the agent
  speaks first, and Resolve reopens the same chat rather than starting another.
  Mock Claude writes no provider transcript, so after a frontend restart the
  reopened chat is identified by its resumable session, not replayed messages.

  Scenario: Resolve opens a Claude gate chat seeded with the gate protocol
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Chat Workflow |
    And I create a step "draft" in the workflow "Gate Chat Workflow" via the CLI
    And I create a human_input step "approve" with instructions "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Chat Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Chat Task     |
      | workflow | Gate Chat Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the GUI should show "local-chat-acceptance reply" within 10 seconds
    And the local chat should show 1 completed assistant responses within 5 seconds
    And the local chat should show no user messages
    And the GUI should not show "resolve the human input gate" within 1 seconds
    And the "claude" harness should have started 1 gate chat asking "Approve Gate Chat Task?" with artifact "approval"

  Scenario: Resolve reopens the gate's chat instead of starting another
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Reopen Workflow |
    And I create a step "draft" in the workflow "Gate Reopen Workflow" via the CLI
    And I create a human_input step "approve" with instructions "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Reopen Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Reopen Task     |
      | workflow | Gate Reopen Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the local chat should show 1 completed assistant responses within 10 seconds
    When I click on the element with title "Close chat panel"
    And I click on the element with test id "human-input-gate-resolve"
    Then the local chat should show 1 completed assistant responses within 5 seconds
    When I reload the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the local chat composer should offer to resume its session within 10 seconds
    And the local chat should show no user messages
    And the "claude" harness should have started 1 gate chat asking "Approve Gate Reopen Task?" with artifact "approval"

  Scenario: Resolve is unavailable for a gate without an artifact
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate No Artifact Workflow |
    And I create a step "draft" in the workflow "Gate No Artifact Workflow" via the CLI
    And I create a human_input step "approve" without an artifact in the workflow "Gate No Artifact Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate No Artifact Task     |
      | workflow | Gate No Artifact Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the GUI should show an element with test id "human-input-gate" within 15 seconds
    And the GUI should show a disabled element with title "Configure an artifact on this step to resolve it in a chat" within 5 seconds

  Scenario: Resolve seeds a Codex gate chat with the same protocol
    Given the daemon is running for the project
    And the default local chat provider is "openai" on the "codex" harness
    And I create a workflow with:
      | name | Gate Codex Workflow |
    And I create a step "draft" in the workflow "Gate Codex Workflow" via the CLI
    And I create a human_input step "approve" with instructions "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Codex Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Codex Task     |
      | workflow | Gate Codex Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the "codex" harness should have started 1 gate chat asking "Approve Gate Codex Task?" with artifact "approval"
    And the Codex gate chat should open with a hidden turn
    And the local chat should show no user messages
    And the "claude" harness should have started 0 gate chats asking "Approve Gate Codex Task?" with artifact "approval"
