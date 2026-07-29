Feature: Artifact validation and not-found behavior
  Reject invalid artifact inputs and surface backend not-found errors.

  Background:
    Given a configured Sacrum client

  Scenario: Empty artifact filename is rejected
    When I add artifact "" with body "body"
    Then the command should fail with "Validation failed: artifact filename cannot be empty"

  Scenario: Artifact list rejects a non-positive limit
    When I list artifacts with --limit 0
    Then the command should fail with "Validation failed: artifact list limit must be greater than zero"

  Scenario: Artifact attachment target requires both fields
    When I run vtb "artifact add target.md --body body --subject-type task"
    Then the command should fail with "Validation failed: subject_type and subject_id must be provided together"

  Scenario: Artifact update requires at least one field
    When I update artifact "00000000-0000-4000-8000-000000000000" without changes
    Then the command should fail with "Validation failed: artifact update requires --filename, --body, or --body-file"

  Scenario: Artifact IDs must be full UUIDs
    When I show artifact "not-a-uuid" as JSON
    Then the command should fail with "artifact ID 'not-a-uuid' is not a valid UUID"

  Scenario: Showing a missing artifact returns a not-found error
    When I show artifact "00000000-0000-4000-8000-000000000000" as JSON
    Then the command should fail with "not found"
