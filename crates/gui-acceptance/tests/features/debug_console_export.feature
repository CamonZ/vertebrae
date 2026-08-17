Feature: Diagnostic console export
  The diagnostic console should write its retained logs and local harness
  traces to a user-selected JSON file.

  Scenario: Exporting diagnostic data writes a valid JSON file
    Given the GUI is showing the task list
    When I open the diagnostic console
    And I export diagnostic console JSON
    Then the diagnostic export file should contain valid JSON
