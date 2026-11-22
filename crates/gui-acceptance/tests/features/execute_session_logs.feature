Feature: Execute session logs stream in the run trace
  Scenario: Script and stdout records arrive before the command exits
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Execute Log Workflow |
    And I create the "stdout" execute logging fixture
    And the streaming step transitions to a finish step
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Execute Log Task     |
      | workflow | Execute Log Workflow |
    And I start the task workflow via the CLI
    And I open the created task's run in the chat
    Then the conversation should show "execute-info" exactly once within 30 seconds
    When I signal the execute command to "print"
    Then the conversation should show "execute-stdout" exactly once within 30 seconds
    And the running execute attempt has durable logs "execute-info,execute-stdout"
    When I signal the execute command to "release"
    And I wait up to 30 seconds for the task to have a completed execution
    And I reload the GUI and reopen the created task's run in the chat
    Then the execute trace shows these messages in order "execute-info,execute-stdout,final-line"

  Scenario: Equal script messages remain separate without a command
    Given the daemon is running for the project
    And I create a workflow with:
      | name | Execute Log Workflow |
    And I create the "duplicate" execute logging fixture
    And the streaming step transitions to a finish step
    And the GUI is on the pipeline view
    And I select factory "No Factory"
    When I create a task with:
      | title    | Execute Log Task     |
      | workflow | Execute Log Workflow |
    And I start the task workflow via the CLI
    And I open the created task's run in the chat
    And I release the script log fixture
    Then the execute trace shows these messages in order "same-rhai-message,same-rhai-message"
    When I wait up to 30 seconds for the task to have a completed execution
    And I reload the GUI and reopen the created task's run in the chat
    Then the execute trace shows these messages in order "same-rhai-message,same-rhai-message"
