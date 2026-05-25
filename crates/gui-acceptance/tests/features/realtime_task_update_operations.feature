# Skipped: the Operations page is hidden from the GUI for now (needs more
# work). The runner excludes @skip-tagged features. Re-enable — or retarget
# these at /board — when Operations work resumes.
@skip
Feature: Real-time task update on operations view
  When a task title is updated via the CLI, the new title should appear
  on the operations view in real-time without requiring a page reload.

  Scenario: Task title updated via CLI reflects on operations view in real-time
    Given the GUI is on the operations view
    When I create a task "Operations Original Title" via the CLI
    Then the GUI should show "Operations Original Title" within 10 seconds
    When I update the task title to "Operations Updated Title" via the CLI
    Then the GUI should show "Operations Updated Title" within 10 seconds
