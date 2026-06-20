@first_run
Feature: First-run installer welcome flow
  On a clean machine (vtb not installed, not on PATH) the app redirects to a
  welcome/consent screen that requires installing the vtb CLI, vtb-daemon,
  and vtb-gate before continuing. These scenarios are tagged @first_run so the
  harness REMOVES the installed markers before each scenario (all other
  scenarios seed them).

  Scenario: First launch shows the welcome/consent screen
    Given the GUI is on the welcome install screen
    Then the GUI should show an element with test id "welcome-page" within 15 seconds
    And the GUI should show an element with test id "welcome-heading" within 10 seconds
    And the GUI should show an element with test id "welcome-cli-checkbox" within 10 seconds
    And the GUI should show an element with test id "welcome-daemon-checkbox" within 10 seconds
    And the GUI should show an element with test id "welcome-gate-checkbox" within 10 seconds
    And the GUI should show an element with test id "welcome-install" within 10 seconds
    And the GUI should show an element with test id "welcome-cancel" within 10 seconds

  Scenario: Installing without the daemon still stages local chat tools
    Given the GUI is on the welcome install screen
    Then the GUI should show an element with test id "welcome-daemon-checkbox" within 15 seconds
    When I uncheck the install component "welcome-daemon-checkbox"
    And I click on the element with test id "welcome-install"
    Then the GUI should show an element with test id "welcome-success" within 30 seconds
    And the installed CLI binary "vtb" should exist on the filesystem
    And the installed CLI binary "vtb-gate" should exist on the filesystem
    And the installed CLI binary "vtb-daemon" should not exist on the filesystem
