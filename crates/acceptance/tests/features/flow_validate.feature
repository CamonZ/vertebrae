Feature: Flow spec validation with named arrangements
  `vtb flow validate` checks a machine-diagram spec offline, with the same
  validator the chat viewer runs. A spec comparing several options as named
  arrangements validates, and an arrangement error names the arrangement.
  No project or Sacrum is needed.

  Background:
    Given the vtb CLI with no project or reachable backend

  Scenario: The three-option reference spec validates
    Given a flow spec file SPEC holding the three-option reference spec
    When I run vtb "flow validate <SPEC>"
    Then the command should succeed
    And the output should contain "valid yaml flow spec"

  Scenario: A part listed in an unknown arrangement is rejected, naming it
    Given a flow spec file SPEC holding the three-option reference spec with "in: [A]" replaced by "in: [A, Zed]"
    When I run vtb "flow validate <SPEC>"
    Then the command should fail
    And the output should contain 'parts[2].in[1]: unknown arrangement "Zed"; arrangements: A, B, current'

  Scenario: JSON output reports the arrangement error at its path
    Given a flow spec file SPEC holding the three-option reference spec with "baseline: current" replaced by "baseline: D"
    When I run vtb "--json flow validate <SPEC>"
    Then the command should fail
    And the output should contain '"valid": false'
    And the output should contain '"path": "baseline"'
    And the output should contain 'baseline names missing arrangement \"D\"'
