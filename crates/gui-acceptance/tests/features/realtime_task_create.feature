Feature: Real-time task creation via WebSocket
  When a task is created via the CLI, it should appear in the GUI
  task list in real-time without requiring a page reload.

  Scenario: Task created via CLI appears in GUI task list
    Given the GUI is showing the task list
    When I create a task "WebSocket Create Test Task" via the CLI
    Then the GUI should show "WebSocket Create Test Task" within 10 seconds
