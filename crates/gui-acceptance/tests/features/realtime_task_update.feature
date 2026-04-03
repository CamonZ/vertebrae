Feature: Real-time task title update via WebSocket
  When a task title is updated via the CLI, the new title should appear
  in the GUI task list in real-time without requiring a page reload.

  Scenario: Task title updated via CLI reflects in GUI in real-time
    Given the GUI is showing the task list
    When I create a task "Original Title Before Update" via the CLI
    Then the GUI should show "Original Title Before Update" within 10 seconds
    When I update the task title to "Updated Title Via WebSocket" via the CLI
    Then the GUI should show "Updated Title Via WebSocket" within 10 seconds
