Feature: Artifact scope and error behavior
  Verify rejected operations do not create artifacts and CRUD errors are surfaced.

  Background:
    Given a configured Sacrum client

  Scenario: Missing artifact IDs fail for show, update, and delete
    When I show artifact "00000000-0000-4000-8000-000000000000" as JSON
    Then the command should fail with "not found"
    When I update artifact "00000000-0000-4000-8000-000000000000" with filename "missing.md" and body "missing"
    Then the command should fail with "not found"
    When I delete artifact "00000000-0000-4000-8000-000000000000" with --force
    Then the command should fail with "not found"

  Scenario: Invalid authorization is rejected across artifact operations
    When I run artifact command "list" with an invalid token
    Then the command should fail
    And the output should match "(?i)invalid (api )?token|invalid authorization|unauthor|forbidden|401"
    When I run artifact command "show 00000000-0000-4000-8000-000000000000" with an invalid token
    Then the command should fail
    And the output should match "(?i)invalid (api )?token|invalid authorization|unauthor|forbidden|401"
    When I run artifact command "artifact update 00000000-0000-4000-8000-000000000000 --body missing" with an invalid token
    Then the command should fail
    And the output should match "(?i)invalid (api )?token|invalid authorization|unauthor|forbidden|401"

  Scenario: An out-of-scope attachment is rejected without persistence
    When I add artifact "rejected.md" with body "must not persist" attached to "task" "00000000-0000-4000-8000-000000000000"
    Then the command should fail
    When I list artifacts as JSON
    Then the command should succeed
    And the artifact list should not contain filename "rejected.md"
