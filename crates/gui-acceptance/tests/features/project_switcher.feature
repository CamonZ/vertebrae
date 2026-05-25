@multi_project
Feature: Sidebar project switcher popover
  The sidebar project avatar opens a popover that lists the known projects and
  offers an "add project" affordance. Clicking the avatar toggles the popover;
  clicking a non-active entry switches the active project (and closes the
  popover); clicking the active entry is a no-op that just closes it.

  These scenarios are tagged @multi_project so the harness provisions a SECOND
  project (registered in config.toml but not selected) — the popover reads
  config.toml via getProjects() on open, so the second project appears as a
  switchable entry.

  # NOTE: The "+" add-project flow (testing criterion #2) opens a NATIVE OS
  # directory picker via the Tauri `open({ directory: true })` dialog. fantoccini
  # drives the WebView only and CANNOT interact with native OS dialogs, so we do
  # NOT automate the picker here — we only assert the add-project button is
  # present/visible. The full add-project flow is covered by the Vitest unit
  # test in crates/gui/src/components/Sidebar.test.tsx.

  Background:
    Given the GUI is showing the task list

  Scenario: Opening the switcher lists projects and the add-project action
    When I click on the element with test id "sidebar-project-avatar"
    Then the GUI should show an element with test id "sidebar-project-switcher" within 10 seconds
    And the GUI should show an element with test id "sidebar-add-project" within 5 seconds

  Scenario: Clicking the avatar again closes the switcher (toggle)
    When I click on the element with test id "sidebar-project-avatar"
    Then the GUI should show an element with test id "sidebar-project-switcher" within 10 seconds
    When I click on the element with test id "sidebar-project-avatar"
    Then the GUI should not show an element with test id "sidebar-project-switcher" within 5 seconds

  Scenario: Switching to the second project changes the active project and closes the popover
    When I click on the element with test id "sidebar-project-avatar"
    Then the GUI should show an element with test id "sidebar-project-switcher" within 10 seconds
    When I switch to the second project
    Then the GUI should not show an element with test id "sidebar-project-switcher" within 5 seconds
    And the second project is the active project within 10 seconds

  Scenario: Clicking the active project entry is a no-op that closes the popover
    When I click on the element with test id "sidebar-project-avatar"
    Then the GUI should show an element with test id "sidebar-project-switcher" within 10 seconds
    When I click the active project entry
    Then the GUI should not show an element with test id "sidebar-project-switcher" within 5 seconds
