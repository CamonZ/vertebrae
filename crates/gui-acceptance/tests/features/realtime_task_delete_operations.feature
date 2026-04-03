Feature: Real-time task deletion on operations view
  When a task is deleted via the CLI, it should disappear from the
  operations view in real-time without requiring a page reload.

  Scenario: Task deleted via CLI disappears from operations view in real-time
    Given the GUI is on the operations view
    When I create a task "Operations Task To Delete" via the CLI
    Then the GUI should show "Operations Task To Delete" within 10 seconds
    When I delete the task via the CLI
    Then the GUI should not show "Operations Task To Delete" within 10 seconds
