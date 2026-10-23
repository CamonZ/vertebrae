@podman
Feature: GUI-managed Podman backend
  The isolated acceptance runner provides a real rootless Podman engine and a
  podman-compose provider. Tauri commands run with poisoned inherited
  targeting variables so success also proves that saved local targets win.

  Background:
    Given the runner has Podman Compose and no Docker tooling

  Scenario: Fresh self-hosted setup creates and selects a project
    Given a fresh GUI-managed Podman backend
    Then the local backend should accept authenticated requests using the saved GUI settings
    When I initialize the prepared project directory through the GUI command
    Then the GUI-created project should be active within 20 seconds
    And the Podman database sentinel and token should be unchanged
    When I restart the GUI application
    Then the GUI-created project should be active within 20 seconds

  Scenario: Provisioning and application restart preserve a usable local backend
    Given a fresh GUI-managed Podman backend
    Then the Podman installation should have valid saved runtime identity
    And the local backend should accept authenticated requests using the saved GUI settings
    And the Podman backend should publish only the saved loopback port
    When I restart the GUI application
    And I reopen the saved Podman backend through the GUI command
    Then the backend command should succeed
    And the Podman database sentinel and token should be unchanged
    And the local backend should accept authenticated requests using the saved GUI settings

  Scenario: A saved installation cannot silently switch to Docker
    Given a fresh GUI-managed Podman backend
    When I request Docker for the saved Podman backend through the GUI command
    Then the backend command should fail with "another container runtime"
    And the Podman database sentinel and token should be unchanged

  Scenario: Changed rootless storage identity is refused before mutation
    Given a fresh GUI-managed Podman backend
    When the saved Podman storage identity changes
    And I reopen the saved Podman backend through the GUI command
    Then the backend command should fail with "storage identity changed"
    And the Podman database sentinel and token should be unchanged

  Scenario: A lost database volume is not recreated or reseeded
    Given a fresh GUI-managed Podman backend
    When the managed Podman database volume is removed
    And I reopen the saved Podman backend through the GUI command
    Then the backend command should fail with "database volume is missing"
    And the lost Podman database volume should remain absent

  Scenario: Fresh setup installs the latest backend with the Docker-free provider
    Given a fresh GUI-managed Podman backend
    When I check that the installed backend is the latest published release
    Then the Podman database sentinel and token should be unchanged
    And the local backend should accept authenticated requests using the saved GUI settings
    And the Podman backend should publish only the saved loopback port
    When I restart the GUI application
    And I reopen the saved Podman backend through the GUI command
    Then the backend command should succeed
    And the Podman database sentinel and token should be unchanged

  Scenario: A saved Docker Compose provider is never silently replaced
    Given a fresh GUI-managed Podman backend
    When the saved provider is a missing legacy Docker Compose installation
    And I reopen the saved Podman backend through the GUI command
    Then the backend command should fail with "saved docker-compose provider is missing"
    And the Podman database sentinel and token should be unchanged
