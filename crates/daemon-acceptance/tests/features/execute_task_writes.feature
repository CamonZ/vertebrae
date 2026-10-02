@execute
Feature: Rhai task writes
  Execute scripts create, update and archive tasks in their own project
  through vtb::tasks. Writes apply immediately.

  The project holds PARENT > SELF > (CHILD_A > GRANDCHILD, CHILD_B, ARCHIVED),
  plus BLOCKER and DEPENDENT. FOREIGN lives in another project. MISSING was
  never created. The script runs on SELF; $ROLE stands for that task's ID.

  Background:
    Given a configured daemon test environment
    And a task hierarchy beside a task in another project

  Scenario: create stores every field and returns the stored task
    Given a Rhai step running:
      """
      let workflow = vtb::tasks::get(task.id).workflow_id;
      let child = vtb::tasks::create(#{
          title: "host-write-child", description: "Created by Rhai", level: "ticket",
          priority: "critical", tags: ["plan:api"], parent_id: task.id,
          workflow_id: workflow, worktree: "../host-write", depends_on: [$BLOCKER]
      });
      let read = vtb::tasks::get(child.id);
      #{
          id: child.id, returned: [child.title, child.level, child.parent_id],
          stored: [read.title, read.description, read.level, read.priority, read.tags,
                   read.parent_id, read.worktree, read.archived],
          workflow: read.workflow_id == workflow,
          blockers: vtb::tasks::dependencies(child.id).map(|t| t.id),
          children: vtb::tasks::children(task.id).len()
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    And the script's id is recorded as CREATED
    Then the script returns:
      """
      {
        "id": $CREATED, "returned": ["host-write-child", "ticket", $SELF],
        "stored": ["host-write-child", "Created by Rhai", "ticket", "critical", ["plan:api"],
                   $SELF, "../host-write", false],
        "workflow": true, "blockers": [$BLOCKER], "children": 4
      }
      """
    And CREATED has never run

  Scenario: create defaults to a root task with the backend's priority and workflow defaults
    Given a Rhai step running:
      """
      let child = vtb::tasks::create(#{ title: "host-write-plain" });
      let cli = vtb::tasks::get($BLOCKER);
      #{
          id: child.id,
          defaults: [child.level, child.description, child.tags, child.parent_id,
                     child.worktree, child.archived],
          like_cli: [child.priority == cli.priority, child.workflow_id == cli.workflow_id]
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    And the script's id is recorded as CREATED
    Then the script returns:
      """
      {
        "id": $CREATED, "defaults": ["task", null, [], null, null, false],
        "like_cli": [true, true]
      }
      """
    And CREATED has never run

  Scenario: update patches and clears fields, and archive and unarchive repeat safely
    Given a Rhai step running:
      """
      let id = $CHILD_B;
      vtb::tasks::update(id, #{
          title: "host-write-renamed", description: "Patched", level: "ticket",
          priority: "low", worktree: "../patched", add_tags: ["new", "both"],
          remove_tags: ["both"]
      });
      let patched = vtb::tasks::get(id);
      vtb::tasks::update(id, #{ description: (), priority: (), worktree: () });
      let cleared = vtb::tasks::get(id);
      let empty = vtb::tasks::update(id, #{});
      vtb::tasks::archive(id);
      vtb::tasks::archive(id);
      let archived = vtb::tasks::get(id).archived;
      vtb::tasks::unarchive(id);
      vtb::tasks::unarchive(id);
      let unarchived = vtb::tasks::get(id);
      #{
          patched: [patched.title, patched.description, patched.level, patched.priority,
                    patched.worktree, patched.tags],
          cleared: [cleared.title, cleared.description, cleared.level, cleared.priority,
                    cleared.worktree, cleared.tags],
          empty: empty, archived: archived,
          unarchived: [unarchived.archived, unarchived.parent_id, unarchived.title]
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {
        "patched": ["host-write-renamed", "Patched", "ticket", "low", "../patched", ["new"]],
        "cleared": ["host-write-renamed", null, "ticket", null, null, ["new"]],
        "empty": null, "archived": true,
        "unarchived": [false, $SELF, "host-write-renamed"]
      }
      """

  Scenario Outline: invalid fields and patches raise invalid and write nothing
    Given a Rhai step running:
      """
      let before = vtb::tasks::get($CHILD_A);
      let caught = ();
      try { <call>; } catch (error) { caught = error; }
      let after = vtb::tasks::get($CHILD_A);
      [caught.kind, caught.function, vtb::tasks::children(task.id).len(),
       before.title == after.title && before.tags == after.tags && before.level == after.level
           && before.parent_id == after.parent_id && before.archived == after.archived
           && before.workflow_id == after.workflow_id
           && before.current_step_id == after.current_step_id]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["invalid", "<function>", 3, true]
      """

    Examples:
      | call                                                              | function              |
      | vtb::tasks::create(#{ title: "  " })                              | vtb::tasks::create    |
      | vtb::tasks::create(#{ title: "x", level: "huge" })                | vtb::tasks::create    |
      | vtb::tasks::create(#{ title: "x", parent_id: "a0000000" })        | vtb::tasks::create    |
      | vtb::tasks::create(#{ title: "x", id: task.id })                  | vtb::tasks::create    |
      | vtb::tasks::create(#{ title: "x", project_id: task.id })          | vtb::tasks::create    |
      | vtb::tasks::update($CHILD_A, #{ title: () })                      | vtb::tasks::update    |
      | vtb::tasks::update($CHILD_A, #{ tags: ["x"] })                    | vtb::tasks::update    |
      | vtb::tasks::update($CHILD_A, #{ status: "done" })                 | vtb::tasks::update    |
      | vtb::tasks::update($CHILD_A, #{ workflow_id: task.id })           | vtb::tasks::update    |
      | vtb::tasks::update($CHILD_A, #{ current_step_id: task.id })       | vtb::tasks::update    |
      | vtb::tasks::update($CHILD_A, #{ completed_at: "2026-10-01" })     | vtb::tasks::update    |
      | vtb::tasks::update($CHILD_A, #{ run_state: "running" })           | vtb::tasks::update    |
      | vtb::tasks::update($CHILD_A, #{ parent_id: $BLOCKER })            | vtb::tasks::update    |
      | vtb::tasks::update($CHILD_A, #{ archived: true })                 | vtb::tasks::update    |
      | vtb::tasks::archive("not-a-uuid")                                 | vtb::tasks::archive   |

  Scenario Outline: targets outside the project are not found and nothing is written
    Given a workflow in the other project
    And a Rhai step running:
      """
      let caught = ();
      try { <call>; } catch (error) { caught = error; }
      [caught.kind, caught.function, vtb::tasks::children(task.id).len(),
       vtb::tasks::find(#{ search: "host-write" }).len()]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["not_found", "<function>", 3, 0]
      """
    And the task in the other project is unchanged

    Examples:
      | call                                                                   | function              |
      | vtb::tasks::create(#{ title: "host-write", parent_id: $FOREIGN })      | vtb::tasks::create    |
      | vtb::tasks::create(#{ title: "host-write", parent_id: $MISSING })      | vtb::tasks::create    |
      | vtb::tasks::create(#{ title: "host-write", depends_on: [$FOREIGN] })   | vtb::tasks::create    |
      | vtb::tasks::create(#{ title: "host-write", workflow_id: $FOREIGN_WORKFLOW }) | vtb::tasks::create |
      | vtb::tasks::create(#{ title: "host-write", workflow_id: $MISSING })    | vtb::tasks::create    |
      | vtb::tasks::update($FOREIGN, #{ title: "host-write" })                 | vtb::tasks::update    |
      | vtb::tasks::update($MISSING, #{})                                      | vtb::tasks::update    |
      | vtb::tasks::archive($FOREIGN)                                          | vtb::tasks::archive   |
      | vtb::tasks::unarchive($MISSING)                                        | vtb::tasks::unarchive |

  Scenario: an uncaught write error fails the execution and the TaskRun
    Given a Rhai step running:
      """
      vtb::tasks::create(#{ title: "" })
      """
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the execution failed with a "invalid" error from "vtb::tasks::create"
