@execute
Feature: Rhai commands
  Execute scripts run local commands through vtb::cmd in the task worktree.
  The daemon runs in the scenario's container, so the command's processes
  are observable. $WORKTREE stands for the task's quoted worktree path.

  Background:
    Given a configured daemon test environment
    And a task whose worktree is a scratch directory

  Scenario: a command runs in the worktree and a non-zero exit is data
    Given a Rhai command step running:
      """
      let result = vtb::cmd::run("sh", ["-c", "pwd -P; printf oops >&2; exit 3"], #{ stdin: "unread" });
      #{ exit_code: result.exit_code, in_worktree: result.stdout == $WORKTREE + "\n", stderr: result.stderr }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {"exit_code": 3, "in_worktree": true, "stderr": "oops"}
      """

  Scenario: a missing program is not_found, distinct from a non-zero exit
    Given a Rhai command step running:
      """
      let missing = ();
      try { vtb::cmd::run("vtb-no-such-program", [], #{}); } catch (error) { missing = error.kind; }
      #{ missing: missing, nonzero: vtb::cmd::run("false", [], #{}).exit_code }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {"missing": "not_found", "nonzero": 1}
      """

  Scenario: an uncaught missing program fails the step with not_found
    Given a Rhai command step running:
      """
      vtb::cmd::run("vtb-no-such-program", [], #{})
      """
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    Then the execution failed with a "not_found" error from "vtb::cmd::run"

  Scenario: cancelling during a command leaves none of its processes behind
    Given a Rhai command step running:
      """
      vtb::cmd::run("sh", ["-c", "sleep 300 & echo $! > child.pid; echo $$ > leader.pid; wait"], #{})
      """
    When I start a TaskRun
    And the command has written "leader.pid" and "child.pid" in the worktree
    And Sacrum broadcasts cancel_step for the running execution
    And I wait for the execution to reach status "failed"
    Then the execution status is "failed"
    And neither "leader.pid" nor "child.pid" is still running
