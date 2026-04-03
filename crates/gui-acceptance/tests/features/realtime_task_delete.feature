Feature: Real-time task deletion via WebSocket
  When a task is deleted via the CLI, it should disappear from the GUI
  task list in real-time without requiring a page reload.

  Scenario: Task deleted via CLI disappears from GUI in real-time
    Given the GUI is showing the task list
    When I create a task "Task To Be Deleted" via the CLI
    Then the GUI should show "Task To Be Deleted" within 10 seconds
    When I delete the task via the CLI
    Then the GUI should not show "Task To Be Deleted" within 10 seconds
