@execute
Feature: Rhai artifact writes
  Execute scripts publish named artifacts on tasks in their project, or on
  the project itself, through vtb::artifacts::put and put_json. A write
  creates or replaces the artifact by subject and logical name, applies
  immediately, and records the execution that wrote it.

  The progress sample comes from docs/agent-context/workflows/steps/execute/
  host-artifact-writes.md.

  SELF has children CHILD_A, CHILD_B and ARCHIVED, none completed, and
  artifacts plan, data, null, broken and huge. CHILD_A has result. The
  project has shared. FOREIGN, in another project, has plan. MISSING was
  never created. The script runs on SELF; $ROLE stands for that entity's ID.

  Background:
    Given a configured daemon test environment
    And a task hierarchy beside a task in another project
    And named artifacts on those tasks and on both projects

  Scenario: put and put_json create artifacts that a later read in the same script sees
    Given a Rhai step running:
      """
      let infos = [
          vtb::artifacts::put(task.id, "notes", "  first line\n\tsecond ✓\r\n"),
          vtb::artifacts::put_json($CHILD_A, "verdict", #{ passed: true, count: 9007199254740993, none: () }),
          vtb::artifacts::put("project", "policy", "Require checks.\n"),
      ];
      #{
          infos: infos.map(|info| [info.logical_name, info.filename, info.metadata.origin]),
          notes: vtb::artifacts::read(task.id, "notes"),
          verdict: vtb::artifacts::read_json($CHILD_A, "verdict"),
          policy: vtb::artifacts::read("project", "policy"),
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {
        "infos": [["notes", "notes.txt", "rhai"], ["verdict", "verdict.json", "rhai"],
                  ["policy", "policy.txt", "rhai"]],
        "notes": "  first line\n\tsecond ✓\r\n",
        "verdict": {"passed": true, "count": 9007199254740993, "none": null},
        "policy": "Require checks.\n"
      }
      """
    And SELF has one artifact named "notes" with filename "notes.txt" and body:
      """
      "  first line\n\tsecond ✓\r\n"
      """
    And CHILD_A has one artifact named "verdict" with filename "verdict.json" and body:
      """
      {"passed": true, "count": 9007199254740993, "none": null}
      """
    And PROJECT has one artifact named "policy" with filename "policy.txt" and body:
      """
      "Require checks.\n"
      """
    And SELF's "notes" artifact was written as text by the last execution
    And CHILD_A's "verdict" artifact was written as json by the last execution
    And PROJECT's "policy" artifact was written as text by the last execution

  Scenario: a put replaces an existing artifact in place
    Given a Rhai step running:
      """
      let replaced = [
          vtb::artifacts::put(task.id, "plan", "replaced plan").id,
          vtb::artifacts::put_json($CHILD_A, "result", ["replaced"]).filename,
          vtb::artifacts::put_json("project", "shared", #{ replaced: true }).filename,
          vtb::artifacts::put(task.id, "plan", "replaced twice").id,
      ];
      #{ replaced: replaced, plan: vtb::artifacts::read(task.id, "plan") }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {"replaced": [$PLAN, "result.json", "shared.json", $PLAN], "plan": "replaced twice"}
      """
    And SELF has one artifact named "plan" with filename "plan.txt" and body:
      """
      "replaced twice"
      """
    And CHILD_A has one artifact named "result" with filename "result.json" and body:
      """
      ["replaced"]
      """
    And PROJECT has one artifact named "shared" with filename "shared.json" and body:
      """
      {"replaced": true}
      """
    And SELF's "plan" artifact was written as text by the last execution
    And CHILD_A's "result" artifact was written as json by the last execution

  Scenario: a script that fails after writing converges when it is retried
    Given a Rhai step running:
      """
      let attempt = execution.failed_count;
      vtb::artifacts::put(task.id, "notes", "attempt " + attempt);
      vtb::artifacts::put_json("project", "progress", #{ attempt: attempt });
      if attempt == 0 { throw "failed after writing"; }
      attempt
      """
    When I start a TaskRun
    And I wait for a retried attempt to complete
    Then the step failed 1 time before it completed
    And the script returns:
      """
      1
      """
    And SELF has one artifact named "notes" with filename "notes.txt" and body:
      """
      "attempt 1"
      """
    And PROJECT has one artifact named "progress" with filename "progress.json" and body:
      """
      {"attempt": 1}
      """
    And SELF's "notes" artifact was written as text by the last execution
    And PROJECT's "progress" artifact was written as json by the last execution

  Scenario: the documented progress sample converges on one artifact
    Given the documented progress sample running twice on SELF
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {
        "first": {"progress": {"children": 3, "completed": 0}, "filename": "progress.json"},
        "second": {"progress": {"children": 3, "completed": 0}, "filename": "progress.json"}
      }
      """
    And SELF has one artifact named "progress" with filename "progress.json" and body:
      """
      {"children": 3, "completed": 0}
      """

  Scenario: output persistence overwrites an explicit put to the same name
    Given a Rhai step running:
      """
      vtb::artifacts::put(task.id, "summary", "explicit write");
      "persisted output"
      """
    And the step is configured with persistence logical name "summary"
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then SELF has one artifact named "summary" with filename "summary.json" and body:
      """
      {"result": "persisted output"}
      """

  Scenario Outline: a write to a task outside the project raises not_found and writes nothing
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
    And the task in the other project has only its own artifact

    Examples:
      | call                                                  | function                 |
      | vtb::artifacts::put($FOREIGN, "plan", "overwritten")  | vtb::artifacts::put      |
      | vtb::artifacts::put_json($FOREIGN, "notes", 1)        | vtb::artifacts::put_json |
      | vtb::artifacts::put($MISSING, "notes", "body")        | vtb::artifacts::put      |
      | vtb::artifacts::put($FOREIGN_PROJECT, "notes", "x")   | vtb::artifacts::put      |

  Scenario Outline: invalid arguments raise a catchable invalid error naming the function
    Given a Rhai step running:
      """
      let caught = ();
      try { <call>; } catch (error) { caught = error; }
      [caught.kind, caught.function, vtb::artifacts::list(task.id).len()]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["invalid", "<function>", 5]
      """

    Examples:
      | call                                              | function                 |
      | vtb::artifacts::put("Project", "notes", "body")   | vtb::artifacts::put      |
      | vtb::artifacts::put(task.id, "", "body")          | vtb::artifacts::put      |
      | vtb::artifacts::put(task.id, "notes", 42)         | vtb::artifacts::put      |
      | vtb::artifacts::put(task.id, "notes", "   ")      | vtb::artifacts::put      |
      | vtb::artifacts::put_json(task.id, "notes", \|\| 1) | vtb::artifacts::put_json |
      | vtb::artifacts::put_json(task.id, "notes", 1.0 / 0.0) | vtb::artifacts::put_json |

  Scenario: an uncaught write error fails the execution and the TaskRun
    Given a Rhai step running:
      """
      vtb::artifacts::put($MISSING, "notes", "body")
      """
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the execution failed with a "not_found" error from "vtb::artifacts::put"
