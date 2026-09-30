Feature: Project creation
  Creating a project from the sidebar must pass through the GUI command to
  Sacrum and make the new project active.

  Scenario: GUI project initialization creates it in Sacrum and selects it
    Given the GUI is showing the task list
    When I initialize the prepared project directory through the GUI command
    Then the GUI-created project should be active within 20 seconds
