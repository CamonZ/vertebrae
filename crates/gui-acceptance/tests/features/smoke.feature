Feature: GUI smoke test
  Verify the Tauri app launches, connects to the project, and renders basic UI.

  Scenario: Task list page loads
    Given the GUI is showing the task list
    Then the GUI shows "Tasks"
