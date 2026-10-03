@execute
Feature: Rhai deletes
  Execute scripts delete tasks in their project through vtb::tasks::delete
  and named artifacts through vtb::artifacts::delete. A task delete cascades
  only when asked, and is refused when it would delete running work: the
  script's own task, a task with an active TaskRun, or a cascade that
  reaches either. A deleted task's artifacts stay behind.

  The scratch-children sample comes from docs/agent-context/workflows/steps/
  execute/host-deletes.md.

  The project holds PARENT > SELF > (CHILD_A > GRANDCHILD, CHILD_B, ARCHIVED),
  plus BLOCKER and DEPENDENT. SELF has artifacts plan, data, null, broken and
  huge; CHILD_A has result; the project has shared. FOREIGN, in another
  project, has plan. MISSING was never created. The script runs on SELF;
  $ROLE stands for that entity's ID.

  Background:
    Given a configured daemon test environment
    And a task hierarchy beside a task in another project
    And named artifacts on those tasks and on both projects

  Scenario: delete removes a named artifact on a task and on the project, and a rerun converges
    Given a Rhai step running:
      """
      let gone = |subject, name| {
          let outcome = "deleted";
          try { vtb::artifacts::delete(subject, name); }
          catch (error) { if error.kind != "not_found" { throw error; } outcome = "already gone"; }
          outcome
      };
      let outcomes = [gone.call(task.id, "plan"), gone.call(task.id, "plan"),
                      gone.call("project", "shared"), gone.call("project", "shared")];
      let left = vtb::artifacts::list(task.id).map(|info| info.logical_name);
      left.sort();
      #{
          outcomes: outcomes,
          left: left,
          project_shared: vtb::artifacts::lookup("project", "shared"),
          child: vtb::artifacts::read($CHILD_A, "result"),
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {
        "outcomes": ["deleted", "already gone", "deleted", "already gone"],
        "left": ["broken", "data", "huge", "null"],
        "project_shared": null,
        "child": "child result"
      }
      """
    And the task in the other project has only its own artifact

  Scenario: a delete without cascade detaches the children, and a rerun converges
    Given a Rhai step running:
      """
      let outcomes = [];
      for attempt in 0..2 {
          try { vtb::tasks::delete($CHILD_A, #{}); outcomes.push("deleted"); }
          catch (error) { if error.kind != "not_found" { throw error; } outcomes.push("already gone"); }
      }
      let grandchild = vtb::tasks::get($GRANDCHILD);
      #{
          outcomes: outcomes,
          child: vtb::tasks::get($CHILD_A),
          grandchild: [grandchild.id, grandchild.parent_id],
          children: vtb::tasks::children(task.id).map(|t| t.id),
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {
        "outcomes": ["deleted", "already gone"],
        "child": null,
        "grandchild": [$GRANDCHILD, null],
        "children": [$CHILD_B, $ARCHIVED]
      }
      """

  Scenario: a cascade deletes the subtree, and its artifacts stay readable by ID
    Given CHILD_A's "result" artifact is recorded as RESULT
    And a Rhai step running:
      """
      let result = vtb::artifacts::lookup($CHILD_A, "result").id;
      vtb::tasks::delete($CHILD_A, #{ cascade: true });
      #{
          result: result,
          gone: [vtb::tasks::get($CHILD_A), vtb::tasks::get($GRANDCHILD)],
          children: vtb::tasks::children(task.id).map(|t| t.id),
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {"result": $RESULT, "gone": [null, null], "children": [$CHILD_B, $ARCHIVED]}
      """
    And the artifact RESULT still has body "child result"

  Scenario: the documented sample deletes scratch children with their artifacts and converges
    Given scratch children of SELF with named artifacts
    And the documented scratch-children sample running twice on SELF
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {"first": {"deleted": [$SCRATCH_A, $SCRATCH_B]}, "second": {"deleted": []}}
      """
    And the scratch children and their artifacts are gone
    And CHILD_A still has its "result" artifact

  Scenario Outline: deleting running work is refused and deletes nothing
    Given a Rhai step running:
      """
      let caught = ();
      try { <call>; } catch (error) { caught = error; }
      [caught.kind, caught.function, caught.message.contains(<reason>), vtb::tasks::get($CHILD_A) != ()]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["invalid", "vtb::tasks::delete", true, true]
      """
    And PARENT and SELF still exist

    Examples:
      | call                                          | reason                                        |
      | vtb::tasks::delete(task.id, #{})               | "is the executing task"                       |
      | vtb::tasks::delete($PARENT, #{ cascade: true }) | "the cascade includes task " + task.id        |

  Scenario: a task with an active TaskRun, or a cascade that includes one, is refused
    Given BUSY, a child of BUSY_PARENT, with an active TaskRun
    And a Rhai step running:
      """
      let caught = [];
      for target in [[$BUSY, false], [$BUSY_PARENT, true]] {
          try { vtb::tasks::delete(target[0], #{ cascade: target[1] }); }
          catch (error) { caught.push([error.kind, error.message.contains("has an active TaskRun")]); }
      }
      #{ caught: caught, busy: vtb::tasks::get($BUSY).parent_id }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {"caught": [["invalid", true], ["invalid", true]], "busy": $BUSY_PARENT}
      """

  Scenario Outline: a target outside the project is not_found and nothing is deleted
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
      ["not_found", "<function>"]
      """
    And the task in the other project is unchanged
    And the task in the other project has only its own artifact

    Examples:
      | call                                               | function               |
      | vtb::tasks::delete($FOREIGN, #{ cascade: true })    | vtb::tasks::delete     |
      | vtb::tasks::delete($MISSING, #{})                   | vtb::tasks::delete     |
      | vtb::artifacts::delete($FOREIGN, "plan")            | vtb::artifacts::delete |
      | vtb::artifacts::delete($MISSING, "plan")            | vtb::artifacts::delete |

  Scenario Outline: invalid arguments raise a catchable invalid error and delete nothing
    Given a Rhai step running:
      """
      let caught = ();
      try { <call>; } catch (error) { caught = error; }
      [caught.kind, caught.function, vtb::tasks::get($CHILD_A) != (), vtb::artifacts::list(task.id).len()]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["invalid", "<function>", true, 5]
      """

    Examples:
      | call                                                | function               |
      | vtb::tasks::delete($CHILD_A, #{ cascade: "yes" })    | vtb::tasks::delete     |
      | vtb::tasks::delete($CHILD_A, #{ force: true })       | vtb::tasks::delete     |
      | vtb::tasks::delete($CHILD_A, ())                     | vtb::tasks::delete     |
      | vtb::artifacts::delete("Project", "plan")            | vtb::artifacts::delete |
      | vtb::artifacts::delete(task.id, "")                  | vtb::artifacts::delete |

  Scenario: an uncaught refused delete fails the execution and the TaskRun
    Given a Rhai step running:
      """
      vtb::tasks::delete(task.id, #{})
      """
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the execution failed with a "invalid" error from "vtb::tasks::delete"
    And PARENT and SELF still exist
