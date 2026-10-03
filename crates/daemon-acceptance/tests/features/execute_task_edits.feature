@execute
Feature: Rhai task content and relationship edits
  Execute scripts edit sections, checklist items, code refs, parents and
  dependencies in their own project through vtb::tasks. Edits apply
  immediately, address sections by their stored ordinal, and do nothing when
  the requested state already holds.

  The checklist sample comes from docs/agent-context/workflows/steps/execute/
  host-edits.md.

  The project holds PARENT > SELF > (CHILD_A > GRANDCHILD, CHILD_B, ARCHIVED),
  plus BLOCKER and DEPENDENT. CHILD_B depends on BLOCKER and DEPENDENT on
  SELF. FOREIGN lives in another project. MISSING was never created. The
  script runs on SELF; $ROLE stands for that task's ID.

  Background:
    Given a configured daemon test environment
    And a task hierarchy beside a task in another project

  Scenario: content edits apply to an existing task and one created in the same script
    Given a Rhai step running:
      """
      let fresh = vtb::tasks::create(#{ title: "host-edit-fresh", parent_id: task.id });
      let edited = [];
      for id in [$CHILD_A, fresh.id] {
          for pass in 0..2 {
              vtb::tasks::add_section(id, #{ type: "goal", content: "Edited from Rhai" });
              vtb::tasks::add_code_ref(id, #{ path: "src/lib.rs", line_start: 3, line_end: 9, name: "roll_up" });
              vtb::tasks::remove_code_ref(id, #{ path: "src/main.rs" });
          }
          let first = vtb::tasks::add_section(id, #{ type: "checklist_item", content: "first" });
          let second = vtb::tasks::add_section(id, #{ type: "checklist_item", content: "second", done: true });
          vtb::tasks::add_code_ref(id, #{ path: "src/main.rs" });
          for pass in 0..2 {
              vtb::tasks::edit_section(id, "checklist_item", first.order, "first, edited");
              vtb::tasks::check_item(id, first.order);
              vtb::tasks::uncheck_item(id, second.order);
          }
          vtb::tasks::remove_code_ref(id, #{ path: "src/main.rs" });
          let read = vtb::tasks::get(id);
          let items = read.sections.filter(|s| s.type == "checklist_item");
          items.sort(|a, b| a.order - b.order);
          edited.push(#{
              goals: read.sections.filter(|s| s.type == "goal").map(|s| s.content),
              items: items.map(|s| [s.order, s.content, s.done]),
              refs: read.code_refs.map(|r| [r.path, r.line_start, r.line_end, r.name])
          });
      }
      #{ id: fresh.id, edited: edited }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    And the script's id is recorded as CREATED
    Then the script returns:
      """
      {
        "id": $CREATED,
        "edited": [
          {
            "goals": ["Edited from Rhai"],
            "items": [[0, "first, edited", true], [1, "second", false]],
            "refs": [["src/lib.rs", 3, 9, "roll_up"]]
          },
          {
            "goals": ["Edited from Rhai"],
            "items": [[0, "first, edited", true], [1, "second", false]],
            "refs": [["src/lib.rs", 3, 9, "roll_up"]]
          }
        ]
      }
      """

  Scenario: the documented checklist sample adds each item once
    Given the documented checklist sample running twice on SELF
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      { "first": { "checklist": 2 }, "second": { "checklist": 2 } }
      """

  Scenario: edits keep addressing stored ordinals after an earlier section is removed
    # The CLI leaves `done` unset on new items, so an unchecked one reads as ().
    Given CHILD_A has checklist items one, two and three, and the CLI removed the first
    And a Rhai step running:
      """
      let id = $CHILD_A;
      let gone = ();
      try { vtb::tasks::edit_section(id, "checklist_item", 0, "zero"); } catch (error) { gone = error.kind; }
      vtb::tasks::edit_section(id, "checklist_item", 2, "three, edited");
      vtb::tasks::check_item(id, 1);
      let items = vtb::tasks::get(id).sections.filter(|s| s.type == "checklist_item");
      items.sort(|a, b| a.order - b.order);
      #{ gone: gone, items: items.map(|s| [s.order, s.content, s.done]) }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      { "gone": "invalid", "items": [[1, "two", true], [2, "three, edited", null]] }
      """

  Scenario: relationship edits converge and never start or advance a TaskRun
    Given a Rhai step running:
      """
      let fresh = vtb::tasks::create(#{ title: "host-edit-fresh" });
      let steps = || [vtb::tasks::get(fresh.id).current_step_id, vtb::tasks::get($BLOCKER).current_step_id];
      let before = steps.call();
      for pass in 0..2 {
          vtb::tasks::set_parent(fresh.id, task.id);
          vtb::tasks::set_parent($CHILD_B, fresh.id);
          vtb::tasks::add_dependency(fresh.id, $BLOCKER);
          vtb::tasks::add_dependency($CHILD_A, fresh.id);
          vtb::tasks::remove_dependency($CHILD_B, $BLOCKER);
          vtb::tasks::remove_parent($GRANDCHILD);
      }
      #{
          id: fresh.id,
          parents: [vtb::tasks::get(fresh.id).parent_id, vtb::tasks::get($CHILD_B).parent_id,
                    vtb::tasks::get($GRANDCHILD).parent_id],
          blockers: [vtb::tasks::dependencies(fresh.id).map(|t| t.id),
                     vtb::tasks::dependencies($CHILD_A).map(|t| t.id),
                     vtb::tasks::dependencies($CHILD_B).len()],
          steps_unchanged: steps.call() == before
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    And the script's id is recorded as CREATED
    Then the script returns:
      """
      {
        "id": $CREATED,
        "parents": [$SELF, $CREATED, null],
        "blockers": [[$BLOCKER], [$CREATED], 0],
        "steps_unchanged": true
      }
      """
    And CREATED has never run
    And BLOCKER has never run

  Scenario Outline: cycles, self-edges and bad content addresses raise invalid and change nothing
    Given a Rhai step running:
      """
      let state = || [
          vtb::tasks::get(task.id), vtb::tasks::get($PARENT), vtb::tasks::get($BLOCKER),
          vtb::tasks::dependencies(task.id).len(), vtb::tasks::dependencies($BLOCKER).len(),
          vtb::tasks::dependencies($CHILD_B).len()
      ];
      let before = state.call();
      let caught = ();
      try { <call>; } catch (error) { caught = error; }
      [caught.kind, caught.function, state.call() == before]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["invalid", "<function>", true]
      """

    Examples:
      | call                                                                      | function                     |
      | vtb::tasks::set_parent(task.id, task.id)                                  | vtb::tasks::set_parent       |
      | vtb::tasks::set_parent(task.id, $GRANDCHILD)                              | vtb::tasks::set_parent       |
      | vtb::tasks::set_parent($PARENT, $CHILD_B)                                 | vtb::tasks::set_parent       |
      | vtb::tasks::add_dependency(task.id, task.id)                              | vtb::tasks::add_dependency   |
      | vtb::tasks::add_dependency(task.id, $DEPENDENT)                           | vtb::tasks::add_dependency   |
      | vtb::tasks::add_dependency($BLOCKER, $CHILD_B)                            | vtb::tasks::add_dependency   |
      | vtb::tasks::edit_section(task.id, "context", 4, "x")                      | vtb::tasks::edit_section     |
      | vtb::tasks::check_item(task.id, 0)                                        | vtb::tasks::check_item       |
      | vtb::tasks::add_section(task.id, #{ type: "summary", content: "x" })      | vtb::tasks::add_section      |
      | vtb::tasks::add_section(task.id, #{ type: "goal", content: "x", order: 0 }) | vtb::tasks::add_section    |
      | vtb::tasks::add_code_ref(task.id, #{ path: "x", line_start: 5, line_end: 4 }) | vtb::tasks::add_code_ref |
      | vtb::tasks::remove_parent("not-a-uuid")                                   | vtb::tasks::remove_parent    |

  Scenario Outline: targets outside the project are not found and nothing is written
    Given a Rhai step running:
      """
      let before = vtb::tasks::get(task.id);
      let caught = ();
      try { <call>; } catch (error) { caught = error; }
      [caught.kind, caught.function, vtb::tasks::get(task.id) == before]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["not_found", "<function>", true]
      """
    And the task in the other project is unchanged

    Examples:
      | call                                                                  | function                      |
      | vtb::tasks::add_section($FOREIGN, #{ type: "goal", content: "x" })    | vtb::tasks::add_section       |
      | vtb::tasks::edit_section($MISSING, "goal", 0, "x")                    | vtb::tasks::edit_section      |
      | vtb::tasks::check_item($FOREIGN, 0)                                   | vtb::tasks::check_item        |
      | vtb::tasks::uncheck_item($MISSING, 0)                                 | vtb::tasks::uncheck_item      |
      | vtb::tasks::add_code_ref($FOREIGN, #{ path: "x" })                    | vtb::tasks::add_code_ref      |
      | vtb::tasks::remove_code_ref($MISSING, #{ path: "x" })                 | vtb::tasks::remove_code_ref   |
      | vtb::tasks::set_parent($FOREIGN, task.id)                             | vtb::tasks::set_parent        |
      | vtb::tasks::set_parent(task.id, $FOREIGN)                             | vtb::tasks::set_parent        |
      | vtb::tasks::remove_parent($FOREIGN)                                   | vtb::tasks::remove_parent     |
      | vtb::tasks::add_dependency(task.id, $FOREIGN)                         | vtb::tasks::add_dependency    |
      | vtb::tasks::add_dependency($MISSING, task.id)                         | vtb::tasks::add_dependency    |
      | vtb::tasks::remove_dependency(task.id, $FOREIGN)                      | vtb::tasks::remove_dependency |
