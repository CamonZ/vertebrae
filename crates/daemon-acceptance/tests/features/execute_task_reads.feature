@execute
Feature: Rhai task reads
  Execute scripts read live tasks in their own project through vtb::tasks.

  The project holds PARENT > SELF > (CHILD_A > GRANDCHILD, CHILD_B, ARCHIVED),
  plus BLOCKER and DEPENDENT where CHILD_B depends on BLOCKER and DEPENDENT
  depends on SELF. FOREIGN lives in another project. MISSING was never
  created. The script runs on SELF; $ROLE stands for that task's ID.

  Background:
    Given a configured daemon test environment
    And a task hierarchy beside a task in another project

  Scenario: get returns the task with its sections and code refs
    Given a Rhai step running:
      """
      let t = vtb::tasks::get(task.id);
      let keys = t.keys();
      keys.sort();
      #{
          keys: keys, id: t.id, title: t.title, description: t.description,
          level: t.level, priority: t.priority, tags: t.tags, parent_id: t.parent_id,
          archived: t.archived, sections: t.sections.map(|s| [s.type, s.content]),
          code_refs: t.code_refs, assigned: t.workflow_id != ()
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {
        "keys": ["archived", "code_refs", "completed_at", "created_at", "current_step_id",
                 "description", "id", "level", "parent_id", "priority", "sections",
                 "started_at", "tags", "title", "updated_at", "workflow_id", "worktree"],
        "id": $SELF, "title": "host-read-self", "description": "Reads its neighbours",
        "level": "task", "priority": "high", "tags": ["host-read"], "parent_id": $PARENT,
        "archived": false, "sections": [["context", "Live host read"]],
        "code_refs": [{"path": "src/lib.rs", "line_start": 3, "line_end": 9,
                       "name": "roll_up", "description": null}],
        "assigned": true
      }
      """

  Scenario Outline: get reads any task in the project by full ID, in any case
    Given a Rhai step running:
      """
      vtb::tasks::get(<id>).title
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      "<title>"
      """

    Examples:
      | id                  | title                |
      | $CHILD_B            | host-read-child-b    |
      | $ARCHIVED           | host-read-archived   |
      | task.id.to_upper()  | host-read-self       |

  Scenario Outline: get returns () for a task outside the project or one that does not exist
    Given a Rhai step running:
      """
      vtb::tasks::get(<id>)
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      null
      """

    Examples:
      | id       |
      | $FOREIGN |
      | $MISSING |

  Scenario Outline: parent returns the direct parent
    Given a Rhai step running:
      """
      vtb::tasks::parent(<id>).id
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      <parent>
      """

    Examples:
      | id         | parent   |
      | task.id    | $PARENT  |
      | $GRANDCHILD | $CHILD_A |
      | $ARCHIVED  | $SELF    |

  Scenario Outline: parent returns () for a root task, a foreign task or a missing task
    Given a Rhai step running:
      """
      vtb::tasks::parent(<id>)
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      null
      """

    Examples:
      | id       |
      | $PARENT  |
      | $FOREIGN |
      | $MISSING |

  Scenario Outline: children returns direct children in creation order, archived included
    Given a Rhai step running:
      """
      vtb::tasks::children(<id>).map(|t| t.id)
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      <children>
      """

    Examples:
      | id       | children                      |
      | task.id  | [$CHILD_A, $CHILD_B, $ARCHIVED] |
      | $CHILD_A | [$GRANDCHILD]                 |
      | $CHILD_B | []                            |

  Scenario: children returns full tasks
    Given a Rhai step running:
      """
      vtb::tasks::children(task.id).map(|t| [t.title, t.parent_id, t.archived])
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      [["host-read-child-a", $SELF, false], ["host-read-child-b", $SELF, false],
       ["host-read-archived", $SELF, true]]
      """

  Scenario Outline: children returns () for a foreign task or a missing task
    Given a Rhai step running:
      """
      vtb::tasks::children(<id>)
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      null
      """

    Examples:
      | id       |
      | $FOREIGN |
      | $MISSING |

  Scenario Outline: dependencies returns a task's direct blockers
    Given a Rhai step running:
      """
      vtb::tasks::dependencies(<id>).map(|t| t.id)
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      <blockers>
      """

    Examples:
      | id         | blockers   |
      | $CHILD_B   | [$BLOCKER] |
      | $DEPENDENT | [$SELF]    |
      | task.id    | []         |

  Scenario Outline: dependents returns the tasks a task blocks
    Given a Rhai step running:
      """
      vtb::tasks::dependents(<id>).map(|t| t.id)
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      <dependents>
      """

    Examples:
      | id       | dependents   |
      | task.id  | [$DEPENDENT] |
      | $BLOCKER | [$CHILD_B]   |
      | $PARENT  | []           |

  Scenario Outline: dependencies and dependents return () for a foreign task or a missing task
    Given a Rhai step running:
      """
      [vtb::tasks::dependencies(<id>), vtb::tasks::dependents(<id>)]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      [null, null]
      """

    Examples:
      | id       |
      | $FOREIGN |
      | $MISSING |

  Scenario Outline: find filters the project's tasks and orders them by creation
    Given a Rhai step running:
      """
      vtb::tasks::find(<filter>).map(|t| t.id)
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      <found>
      """

    Examples:
      | filter                                           | found                                                                     |
      | #{}                                              | [$PARENT, $SELF, $CHILD_A, $CHILD_B, $GRANDCHILD, $BLOCKER, $DEPENDENT] |
      | #{ parent_id: task.id }                          | [$CHILD_A, $CHILD_B]                                                      |
      | #{ parent_id: task.id, include_archived: true }  | [$CHILD_A, $CHILD_B, $ARCHIVED]                                           |
      | #{ root_only: true }                             | [$PARENT, $BLOCKER, $DEPENDENT]                                           |
      | #{ tags: ["host-read"] }                         | [$SELF, $CHILD_A]                                                         |
      | #{ level: "ticket" }                             | [$PARENT]                                                                 |
      | #{ priority: "low" }                             | [$CHILD_A]                                                                |
      | #{ search: "grandchild" }                        | [$GRANDCHILD]                                                             |
      | #{ search: "host-read-child-b" }                 | [$CHILD_B]                                                                |
      | #{ tags: ["nothing-has-this"] }                  | []                                                                        |

  Scenario: find returns full tasks with their sections and code refs
    Given a Rhai step running:
      """
      vtb::tasks::find(#{ tags: ["host-read"] }).map(|t| [t.title, t.sections.len(), t.code_refs.len()])
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      [["host-read-self", 1, 1], ["host-read-child-a", 0, 0]]
      """

  Scenario Outline: find returns () when the parent is outside the project or does not exist
    Given a Rhai step running:
      """
      vtb::tasks::find(#{ parent_id: <id> })
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      null
      """

    Examples:
      | id       |
      | $FOREIGN |
      | $MISSING |

  Scenario Outline: invalid arguments raise a catchable invalid error naming the function
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

    Examples:
      | call                                               | function                 |
      | vtb::tasks::get("a0000000")                        | vtb::tasks::get          |
      | vtb::tasks::parent(42)                             | vtb::tasks::parent       |
      | vtb::tasks::children(())                           | vtb::tasks::children     |
      | vtb::tasks::dependencies("not-a-uuid")             | vtb::tasks::dependencies |
      | vtb::tasks::dependents(true)                       | vtb::tasks::dependents   |
      | vtb::tasks::find(#{ bogus: 1 })                    | vtb::tasks::find         |
      | vtb::tasks::find(#{ step_name: "reads" })          | vtb::tasks::find         |
      | vtb::tasks::find(#{ project_id: task.id })         | vtb::tasks::find         |
      | vtb::tasks::find(#{ level: "huge" })               | vtb::tasks::find         |
      | vtb::tasks::find(#{ parent_id: task.id, root_only: true }) | vtb::tasks::find |

  Scenario: an uncaught host error fails the execution and the TaskRun
    Given a Rhai step running:
      """
      vtb::tasks::get("a0000000")
      """
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the execution failed with a "invalid" error from "vtb::tasks::get"
