Feature: Standalone daemon telemetry
  A standalone daemon publishes a sanitized startup report and Sacrum exposes
  it through the daemon fleet snapshot.

  Scenario: Publish startup telemetry after standalone enrollment
    Given a configured daemon test environment
    When I enroll and start a standalone daemon
    Then the daemon fleet snapshot contains startup telemetry
    And the daemon fleet snapshot contains no credential or executable path
