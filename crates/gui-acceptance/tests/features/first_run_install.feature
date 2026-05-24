@first_run
Feature: First-run installer welcome flow
  On a clean machine (vtb not installed, not on PATH, no skip flag) the app
  redirects to a welcome/consent screen that offers to install the vtb CLI and
  vtb-daemon. These scenarios are tagged @first_run so the harness REMOVES the
  installer skip flag before each scenario (all other scenarios seed it).

  Scenario: First launch shows the welcome/consent screen
    Given the GUI is on the welcome install screen
    Then the GUI should show an element with test id "welcome-page" within 15 seconds
    And the GUI should show an element with test id "welcome-heading" within 10 seconds
    And the GUI should show an element with test id "welcome-cli-checkbox" within 10 seconds
    And the GUI should show an element with test id "welcome-daemon-checkbox" within 10 seconds
    And the GUI should show an element with test id "welcome-install" within 10 seconds
    And the GUI should show an element with test id "welcome-skip" within 10 seconds

  Scenario: Skipping the installer makes the app usable
    Given the GUI is on the welcome install screen
    Then the GUI should show an element with test id "welcome-skip" within 15 seconds
    When I click on the element with test id "welcome-skip"
    Then the URL should not contain "/welcome" within 15 seconds

  Scenario: Installing the CLI only stages vtb without the daemon
    Given the GUI is on the welcome install screen
    Then the GUI should show an element with test id "welcome-daemon-checkbox" within 15 seconds
    When I uncheck the install component "welcome-daemon-checkbox"
    And I click on the element with test id "welcome-install"
    Then the GUI should show an element with test id "welcome-success" within 30 seconds
    And the installed CLI binary "vtb" should exist on the filesystem
    And the installed CLI binary "vtb-daemon" should not exist on the filesystem
