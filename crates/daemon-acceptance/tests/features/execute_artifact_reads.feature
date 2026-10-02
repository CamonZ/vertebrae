@execute
Feature: Rhai artifact reads
  Execute scripts read named artifacts on tasks and on their own project through vtb::artifacts.

  SELF has plan (whitespace and Unicode text), data (JSON), null (JSON null),
  broken (malformed JSON), huge (an integer beyond 64 bits) and one unnamed
  artifact. CHILD_A has result. The project has shared. FOREIGN, in another
  project, has plan (FOREIGN_PLAN), and that project has its own shared.
  The script runs on SELF; $ROLE stands for that entity's ID.

  Background:
    Given a configured daemon test environment
    And a task hierarchy beside a task in another project
    And named artifacts on those tasks and on both projects

  Scenario: read returns the body byte-for-byte
    Given a Rhai step running:
      """
      [vtb::artifacts::read(task.id, "plan"), vtb::artifacts::read(task.id.to_upper(), "plan")]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["  # Plan\n\n\tstep one  \n✓ done\r\n", "  # Plan\n\n\tstep one  \n✓ done\r\n"]
      """

  Scenario Outline: read returns the body on another task or the project
    Given a Rhai step running:
      """
      vtb::artifacts::read(<subject>, "<name>")
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      "<body>"
      """

    Examples:
      | subject   | name   | body           |
      | $CHILD_A  | result | child result   |
      | "project" | shared | project shared |

  Scenario Outline: read returns () without falling back to another subject or project
    Given a Rhai step running:
      """
      vtb::artifacts::read(<subject>, "<name>")
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      null
      """

    Examples:
      | subject           | name   |
      | $CHILD_A          | plan   |
      | "project"         | plan   |
      | task.id           | shared |
      | task.id           | absent |
      | $MISSING          | plan   |
      | $FOREIGN          | plan   |
      | $FOREIGN_PLAN     | plan   |
      | $PROJECT          | shared |
      | $FOREIGN_PROJECT  | shared |

  Scenario: lookup returns artifact metadata without the body
    Given a Rhai step running:
      """
      let info = vtb::artifacts::lookup(task.id, "plan");
      let keys = info.keys();
      keys.sort();
      #{
          keys: keys, id: info.id, filename: info.filename,
          logical_name: info.logical_name, timestamped: type_of(info.created_at) == "string"
      }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {
        "keys": ["created_at", "filename", "id", "logical_name", "metadata", "updated_at"],
        "id": $PLAN, "filename": "plan.txt", "logical_name": "plan", "timestamped": true
      }
      """

  Scenario Outline: lookup returns () for an absent name, a foreign subject or a missing task
    Given a Rhai step running:
      """
      vtb::artifacts::lookup(<subject>, "<name>")
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      null
      """

    Examples:
      | subject   | name   |
      | task.id   | absent |
      | $CHILD_A  | plan   |
      | $FOREIGN  | plan   |
      | $MISSING  | plan   |

  Scenario: read_json keeps exact integers, nulls and nested values
    Given a Rhai step running:
      """
      let data = vtb::artifacts::read_json(task.id, "data");
      #{ data: data, next: data.exact + 1 }
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      {
        "data": {"max": 9223372036854775807, "min": -9223372036854775808,
                 "exact": 9007199254740993, "none": null,
                 "nested": [{"ok": true, "ratio": 0.5}, []]},
        "next": 9007199254740994
      }
      """

  Scenario Outline: read_json returns () for JSON null, an absent name or a foreign subject
    Given a Rhai step running:
      """
      vtb::artifacts::read_json(<subject>, "<name>")
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      null
      """

    Examples:
      | subject  | name   |
      | task.id  | null   |
      | task.id  | absent |
      | $FOREIGN | plan   |

  Scenario Outline: read_json raises invalid for a body it cannot represent
    Given a Rhai step running:
      """
      let caught = ();
      try { vtb::artifacts::read_json(task.id, "<name>"); } catch (error) { caught = error; }
      [caught.kind, caught.function, caught.message.contains("<detail>")]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      ["invalid", "vtb::artifacts::read_json", true]
      """

    Examples:
      | name   | detail                                  |
      | broken | not valid JSON                          |
      | huge   | integer 100000000000000000000 is outside |

  Scenario Outline: list returns a subject's named artifacts
    Given a Rhai step running:
      """
      let names = vtb::artifacts::list(<subject>).map(|info| info.logical_name);
      names.sort();
      names
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      <names>
      """

    Examples:
      | subject   | names                                        |
      | task.id   | ["broken", "data", "huge", "null", "plan"]   |
      | $CHILD_A  | ["result"]                                   |
      | "project" | ["shared"]                                   |
      | $CHILD_B  | []                                           |

  Scenario: list returns metadata without bodies
    Given a Rhai step running:
      """
      vtb::artifacts::list($CHILD_A).map(|info| [info.filename, info.contains("body")])
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      [["result.txt", false]]
      """

  Scenario: list follows every page of a subject's artifacts
    Given a task with 53 named artifacts
    And a Rhai step running:
      """
      let names = vtb::artifacts::list($MANY).map(|info| info.logical_name);
      names.sort();
      [names.len(), names[0], names[52]]
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      [53, "item-00", "item-52"]
      """

  Scenario Outline: list returns () for a foreign task or a missing task
    Given a Rhai step running:
      """
      vtb::artifacts::list(<subject>)
      """
    When I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the script returns:
      """
      null
      """

    Examples:
      | subject  |
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
      | call                                          | function                  |
      | vtb::artifacts::list("Project")               | vtb::artifacts::list      |
      | vtb::artifacts::list("a0000000")              | vtb::artifacts::list      |
      | vtb::artifacts::lookup(42, "plan")            | vtb::artifacts::lookup    |
      | vtb::artifacts::read(task.id, "")             | vtb::artifacts::read      |
      | vtb::artifacts::read("project", "   ")        | vtb::artifacts::read      |
      | vtb::artifacts::read_json(task.id, 7)         | vtb::artifacts::read_json |

  Scenario: an uncaught host error fails the execution and the TaskRun
    Given a Rhai step running:
      """
      vtb::artifacts::read_json(task.id, "broken")
      """
    When I start a TaskRun
    And I wait for the execution to reach status "failed"
    And I wait for the TaskRun to reach status "failed" with outcome "retry_exhausted"
    Then the execution failed with a "invalid" error from "vtb::artifacts::read_json"
