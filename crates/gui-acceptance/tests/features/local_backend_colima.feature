@colima
Feature: Project setup using Docker on Colima without Podman
  All setup actions use visible UI controls. The runner supplies installed
  component binaries, Docker/Compose, and a real Colima socket, with no saved
  backend configuration or projects and no Podman executable.

  Scenario: A new user selects Docker, refreshes discovery and creates a project
    Given the fresh Colima GUI is on project setup
    When I click on the element with test id "backend-choice-local"
    And I click on the element with test id "backend-choice-continue"
    Then I can select Docker in the visible container runtime control
    And the setup form should stay above its footer in small windows
    When I refresh container runtimes using the setup screen
    Then I can select Docker in the visible container runtime control
    When I choose the Colima project folder using the native dialog
    And I enter the Colima project name through the setup form
    Then the Create project button should be unobstructed
    When I click on the element with test id "project-phase-continue"
    Then the GUI should finish Colima project setup within 600 seconds
    When I click on the element with test id "ignition-enter"
    Then the Colima project should be selected in the sidebar
