@podman
Feature: GUI-managed Podman backend
  The isolated acceptance runner provides a real rootless Podman engine and a
  standalone Compose provider. Tauri commands run with poisoned inherited
  targeting variables so success also proves that saved local targets win.

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
