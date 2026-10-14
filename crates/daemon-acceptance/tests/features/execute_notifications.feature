@execute @notifications
Feature: Rhai notifications
  Execute scripts publish Markdown notifications to their project through
  vtb::notifications::send. Sacrum stores each one exactly as composed,
  serves it as paginated history and keeps its read state.

  The report sample comes from docs/agent-context/workflows/steps/execute/
  host-notifications.md.

  SELF is a task in the scenario's project; the script runs on SELF and
  $ROLE stands for that entity's ID. Notifications are read back through the
  scenario's own project.

  Background:
    Given a configured daemon test environment
    And a task hierarchy beside a task in another project

  Scenario: the documented report sample links an artifact and its task
    Given the documented report sample running on SELF
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then SELF's "report" artifact is known as REPORT
    And the script's notification_id is the ID of the project's only notification
    And the project's notifications are:
      """
      [["Artifact [report](vtb://artifact/$REPORT) has been added to task [host-read-self](vtb://task/$SELF).", "success", false]]
      """

  Scenario: composed messages are stored byte for byte and each send creates a notification
    Given a Rhai step running:
      """
      let title = "Ship [it] *now*";
      let link = "[" + vtb::notifications::escape(title) + "](vtb://task/" + task.id + ")";
      let sent = [
          vtb::notifications::send(#{ message: "Task " + link + " needs review\n\n- `" + title + "` ✓", severity: "warning" }),
          vtb::notifications::send(#{ message: "Started" }),
          vtb::notifications::send(#{ message: "Started" }),
      ];
      sent.map(|n| {
          let message = n.message;
          message.replace(task.id, "SELF");
          [message, n.severity, n.read_at, n.project_id, n.inserted_at != ()]
      })
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      [
        ["Task [Ship \\[it\\] \\*now\\*](vtb://task/SELF) needs review\n\n- `Ship [it] *now*` ✓", "warning", null, $PROJECT, true],
        ["Started", "info", null, $PROJECT, true],
        ["Started", "info", null, $PROJECT, true]
      ]
      """
    And the project's notifications are:
      """
      [
        ["Task [Ship \\[it\\] \\*now\\*](vtb://task/$SELF) needs review\n\n- `Ship [it] *now*` ✓", "warning", false],
        ["Started", "info", false],
        ["Started", "info", false]
      ]
      """
    And paging the project's notifications one at a time returns the same 3 in order
    When I mark the project's notifications read
    Then every project notification is read and no unread notification remains
    And marking them read again keeps their first read time

  Scenario Outline: invalid arguments raise a catchable invalid error and publish nothing
    Given a Rhai step running:
      """
      let caught = ();
      try { <call>; } catch (error) { caught = error; }
      [caught.kind, caught.function]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["invalid", "<function>"]
      """
    And the project has no notifications

    Examples:
      | call                                                                  | function                    |
      | vtb::notifications::send("Done")                                      | vtb::notifications::send    |
      | vtb::notifications::send(#{ severity: "info" })                       | vtb::notifications::send    |
      | vtb::notifications::send(#{ message: "   " })                         | vtb::notifications::send    |
      | vtb::notifications::send(#{ message: "Done", severity: "fatal" })     | vtb::notifications::send    |
      | vtb::notifications::send(#{ message: "Done", project_id: $FOREIGN_PROJECT }) | vtb::notifications::send |
      | let long = ""; for i in 0..4097 { long += "x"; } vtb::notifications::send(#{ message: long }) | vtb::notifications::send |
      | vtb::notifications::escape(42)                                        | vtb::notifications::escape  |

  Scenario: an uncaught send error fails the execution
    Given a Rhai step running:
      """
      vtb::notifications::send(#{ message: "" })
      """
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    Then the execution failed with a "invalid" error from "vtb::notifications::send"
    And the project has no notifications
