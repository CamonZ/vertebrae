Feature: Real-time task creation on operations view
  When a task is created via the CLI, it should appear on the
  operations view in real-time without requiring a page reload.

  Scenario: Task created via CLI appears on operations view
    Given the GUI is on the operations view
    When I create a task "Operations Create Test Task" via the CLI
    Then the GUI should show "Operations Create Test Task" within 10 seconds
