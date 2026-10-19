Feature: Resolve a human_input gate in a local chat
  A TaskRun waiting at a human_input gate offers Resolve. Resolve opens a
  local chat bound to the gate: the harness starts with hidden instructions
  carrying the gate's question, schema and exact submit command, the agent
  speaks first, and Resolve reopens the same chat rather than starting another.
  Mock Claude writes no provider transcript, so after a frontend restart the
  reopened chat is identified by its resumable session, not replayed messages.
  When the review loops a rejected answer back, the same chat shows the new
  attempt and receives one hidden evaluation turn with the reasons; the chat
  shows the gate closed once the run finishes or stops.
  A gate whose output schema Sacrum accepts field by field is answered through
  its durable draft instead: the protocol records answers with vtb gate, the
  chat shows each field's progress, stalled conversations are steered back to
  what is still needed, a chat whose session ended is replaced by one that
  starts from the draft, and simple gates can be answered without a chat.

  Scenario: Resolve opens a Claude gate chat seeded with the gate protocol
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Chat Workflow |
    And I create a step "draft" in the workflow "Gate Chat Workflow" via the CLI
    And I create a human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Chat Workflow" via the CLI
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
    And I create a human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Reopen Workflow" via the CLI
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
    And I create a human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Codex Workflow" via the CLI
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

  Scenario: A rejected resolution is explained in the same chat until the run finishes
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Review Workflow |
    And I create a step "draft" in the workflow "Gate Review Workflow" via the CLI
    And I create a reviewed human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Review Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Review Task     |
      | workflow | Gate Review Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the local chat should show 1 completed assistant responses within 10 seconds
    And the GUI should show "Drafting" within 10 seconds
    When I resolve the waiting gate's "approval" artifact with '{"approved": false, "reason": "The rollback plan is missing."}' via the CLI
    Then the GUI should show "Rejected · attempt 2" within 20 seconds
    And the gate chat should receive 1 evaluation turn for attempt 2 with reasons "The rollback plan is missing."
    And the local chat should be ready for a message within 10 seconds
    And the local chat should show no user messages
    When I resolve the waiting gate's "approval" artifact with '{"approved": true, "reason": "The rollback plan is attached."}' via the CLI
    Then the GUI should show "Gate closed" within 20 seconds

  Scenario: Stopping the run closes its gate chat
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Stop Workflow |
    And I create a step "draft" in the workflow "Gate Stop Workflow" via the CLI
    And I create a human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Stop Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Stop Task     |
      | workflow | Gate Stop Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the GUI should show "Drafting" within 10 seconds
    When I stop the task workflow via the CLI
    Then the GUI should show "Gate closed" within 20 seconds

  Scenario: A draftable gate chat records answers through the draft and shows their progress
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Draft Workflow |
    And I create a step "draft" in the workflow "Gate Draft Workflow" via the CLI
    And I create a draftable human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Draft Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Draft Task     |
      | workflow | Gate Draft Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the "claude" harness should have started 1 draft gate chat asking "Approve Gate Draft Task?"
    And the gate draft progress should show "approved" as "missing" within 10 seconds
    And the gate draft progress should show "reason" as "missing" within 5 seconds
    When I set the waiting gate's draft to '{"approved": true}' via the CLI
    Then the vtb output should contain "Still needed: reason"
    And the gate draft progress should show "approved" as "answered" within 10 seconds
    And the gate draft progress should show "reason" as "missing" within 5 seconds
    When I set the waiting gate's draft to '{"reason": "The rollback plan is attached."}' via the CLI
    Then the vtb output should contain "Complete — confirm with the user, then submit."
    When I submit the waiting gate's draft via the CLI
    Then the GUI should show "Gate closed" within 20 seconds

  Scenario: A rejected draft returns with its answers kept for revision
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Draft Review Workflow |
    And I create a step "draft" in the workflow "Gate Draft Review Workflow" via the CLI
    And I create a reviewed draftable human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Draft Review Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Draft Review Task     |
      | workflow | Gate Draft Review Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the local chat should show 1 completed assistant responses within 10 seconds
    When I set the waiting gate's draft to '{"approved": false, "reason": "The rollback plan is missing."}' via the CLI
    And I submit the waiting gate's draft via the CLI
    Then the GUI should show "Rejected · attempt 2" within 20 seconds
    And the gate chat should receive 1 evaluation turn for attempt 2 with reasons "The rollback plan is missing."
    And the evaluation turn should present 'reason: "The rollback plan is missing."' as a previous answer
    And the gate draft progress should show "reason" as "answered" within 10 seconds

  Scenario: A stalled draftable gate chat is steered back to what is still needed
    Given the daemon is running for the project
    And gate chats are steered after 1, 2 and 3 stalled turns
    And I create a workflow with:
      | name | Gate Steering Workflow |
    And I create a step "draft" in the workflow "Gate Steering Workflow" via the CLI
    And I create a draftable human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Steering Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Steering Task     |
      | workflow | Gate Steering Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the local chat should be ready for a message within 10 seconds
    When I type "What is this about?" into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the gate chat should receive 1 steering turn naming "approved (Should it ship?); reason (Why?)"
    And the local chat should be ready for a message within 10 seconds
    When I type "Tell me more first." into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show an element with test id "gate-steering-form" within 10 seconds
    And the GUI should not show an element with test id "gate-steering-escape" within 1 seconds
    When I click on the element with test id "gate-answer-input-approved-yes"
    And I click on the element with test id "gate-steering-answer-form-submit"
    Then the gate chat should receive a form turn reporting "approved: true"
    And the gate draft progress should show "approved" as "answered" within 10 seconds
    And the GUI should not show an element with test id "gate-steering-form" within 5 seconds
    And the local chat should be ready for a message within 10 seconds
    When I type "Still thinking." into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the gate chat should receive 2 steering turns naming "reason (Why?)"
    And the local chat should be ready for a message within 10 seconds
    When I type "Hmm." into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the local chat should be ready for a message within 10 seconds
    When I type "Not sure." into the element with test id "local-chat-composer"
    And I press the "Enter" key
    Then the GUI should show an element with test id "gate-steering-escape" within 10 seconds
    When I click on the element with test id "gate-steering-keep-going"
    Then the GUI should not show an element with test id "gate-steering" within 5 seconds
    And the local chat should show 5 user messages, none of them from Vertebrae

  Scenario: Resolve continues an ended draftable gate chat in a new chat from the draft
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Recovery Workflow |
    And I create a step "draft" in the workflow "Gate Recovery Workflow" via the CLI
    And I create a draftable human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Recovery Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Recovery Task     |
      | workflow | Gate Recovery Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the local chat should show 1 completed assistant responses within 10 seconds
    When I set the waiting gate's draft to '{"approved": true}' via the CLI
    And I reload the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    When I click on the element with test id "human-input-gate-resolve"
    Then the "claude" harness should have started 2 draft gate chats asking "Approve Gate Recovery Task?"
    And the latest "claude" gate chat asking "Approve Gate Recovery Task?" should start from the answer "approved: true" with "reason" still needed
    And the gate chat should open with the recovery turn
    And the local chat should show no user messages

  Scenario: A draftable gate is answered directly without a chat
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Direct Workflow |
    And I create a step "draft" in the workflow "Gate Direct Workflow" via the CLI
    And I create a draftable human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Direct Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Direct Task     |
      | workflow | Gate Direct Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the GUI should show an element with test id "human-input-gate-answer-directly" within 15 seconds
    When I click on the element with test id "human-input-gate-answer-directly"
    And I click on the element with test id "gate-answer-input-approved-yes"
    And I type "Ready to ship." into the element with test id "gate-answer-input-reason"
    And I click on the element with test id "human-input-gate-answer-form-submit"
    Then the GUI should not show an element with test id "human-input-gate" within 20 seconds
    And the "claude" harness should have started 0 draft gate chats asking "Approve Gate Direct Task?"

  Scenario: A whole-artifact gate offers no direct answer
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Gate Artifact Workflow |
    And I create a step "draft" in the workflow "Gate Artifact Workflow" via the CLI
    And I create a human_input step "approve" with question "Approve {{ task.title }}?" and artifact "approval" in the workflow "Gate Artifact Workflow" via the CLI
    And the GUI is showing the task list
    When I create a task with:
      | title    | Gate Artifact Task     |
      | workflow | Gate Artifact Workflow |
    And I transition the task to step "approve" via the CLI
    And I start the task workflow via the CLI
    And I navigate to the traces page for the created task
    Then the human_input gate should offer Resolve within 15 seconds
    And the GUI should not show an element with test id "human-input-gate-answer-directly" within 3 seconds
