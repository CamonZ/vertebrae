Feature: Worktree project resolution
  When `vtb` runs inside a VCS workspace, it must resolve to the registered
  project root (not error out with "No vertebrae project found").

  Scenario: vtb runs in a worktree of a registered project
    Given a configured Sacrum client
    And the project is registered at a temporary git repository
    And a git worktree of that repository
    When I run vtb add "Worktree-resolved task" from the worktree directory
    Then the command succeeds
    And the created task belongs to the configured project

  Scenario: vtb add resolves a registered non-colocated JJ workspace without project env
    Given a configured Sacrum client
    And the project is registered at a temporary non-colocated JJ workspace
    When I run vtb add "JJ workspace-resolved task" from the VCS workspace directory
    Then the command succeeds
    And the created task belongs to the configured project
