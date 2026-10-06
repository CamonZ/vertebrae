Feature: Artifact input and output modes
  Exercise the supported body sources and human/JSON command output.

  Background:
    Given a configured Sacrum client

  Scenario: Add artifacts from a file and stdin, then update from a file
    When I add artifact "from-file.md" from a body file containing "file body"
    Then the command should succeed
    When I add artifact "from-stdin.md" from stdin containing "stdin body"
    Then the command should succeed
    When I show artifact "<artifact_id>" for humans
    Then the command should succeed
    And the output should contain "Filename: from-stdin.md"
    And the output should contain "Body:"
    And the output should contain "stdin body"
    When I update artifact "<artifact_id>" with filename "updated-from-file.md" and body file containing "updated file body"
    Then the command should succeed
    When I show artifact "<artifact_id>" as JSON
    Then the artifact JSON should have filename "updated-from-file.md" and body "updated file body"

  Scenario: Add, update, and delete artifacts with JSON output
    When I add artifact "json.md" with body "json body" as JSON
    Then the command should succeed
    And the artifact JSON status should be "created"
    When I update artifact "<artifact_id>" with filename "updated-json.md" and body "updated json body" as JSON
    Then the command should succeed
    And the artifact JSON status should be "updated"
    When I delete artifact "<artifact_id>" with --force as JSON
    Then the command should succeed
    And the artifact JSON status should be "deleted"

  Scenario: Human artifact listing reports an empty project
    When I list artifacts for humans
    Then the command should succeed
    And the human artifact list should say "No artifacts found"

  Scenario: Artifact listing returns all 100 artifacts beyond the former page limit
    When I create 100 numbered project artifacts
    And I list artifacts as JSON
    Then the command should succeed
    And the JSON artifact listing contains all 100 numbered artifacts
    And every listed artifact should belong to the active project
    When I list artifacts for humans
    Then the command should succeed
    And the human artifact listing contains all 100 numbered artifacts
