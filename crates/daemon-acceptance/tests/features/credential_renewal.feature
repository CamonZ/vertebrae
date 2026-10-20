@credential_renewal
Feature: Automatic daemon credential renewal
  An enrolled daemon renews its reconnect credential through
  renewDaemonCredential once less than 24 hours of lifetime remain, with its
  default configuration and no renewal settings. Credentials it cannot renew
  put it in a re-enrollment-required state instead of a restart loop.

  Scenario: A credential inside the renewal window is renewed and keeps working
    Given an enrolled standalone daemon that is not running
    And the persisted daemon credential expires in 2 hours
    When I start the enrolled daemon
    Then the daemon renews its reconnect credential
    And the daemon is online
    And the enrolled reconnect credential is rejected
    Given a workflow with one inference step
    And a task assigned to the workflow
    When the mock is scripted to succeed with full metrics
    And I start a TaskRun
    And I wait for the execution to reach status "completed"
    Then the execution status is "completed"
    And the daemon output contains no credential plaintext

  Scenario: A restarted daemon uses the renewed credential without renewing again
    Given an enrolled standalone daemon that is not running
    And the persisted daemon credential expires in 2 hours
    When I start the enrolled daemon
    Then the daemon renews its reconnect credential
    When I restart the daemon
    Then the daemon reconnects with the renewed credential without renewing again
    And the daemon output contains no credential plaintext

  Scenario: An expired credential requires re-enrollment without connecting
    Given an enrolled standalone daemon that is not running
    And the persisted daemon credential expired 2 hours ago
    When I start the enrolled daemon without waiting for registration
    Then the daemon reports that re-enrollment is required
    And the daemon makes no socket connection attempts
    And the daemon keeps running without restarting
    And the daemon output contains no credential plaintext

  Scenario: Owner rotation requires re-enrollment and re-enrolling restores the daemon
    Given an enrolled standalone daemon that is not running
    When I start the enrolled daemon
    Then the daemon is online
    When the owner rotates the daemon credentials
    Then the daemon reports that re-enrollment is required
    And the daemon keeps running without restarting
    When I re-enroll the daemon with the rotated bootstrap credential
    Then the daemon resumes with the re-enrolled credential
    And the daemon output contains no credential plaintext
