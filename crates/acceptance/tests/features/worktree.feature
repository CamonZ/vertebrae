Feature: Worktree project resolution
  When `vtb` runs inside a git worktree, it must resolve to the main repo's
  registered project (not error out with "No vertebrae project found").

  Scenario: vtb runs in a worktree of a registered project
    Given a configured Sacrum client
    And the project is registered at a temporary git repository
    And a git worktree of that repository
    When I run vtb add "Worktree-resolved task" from the worktree directory
    Then the command succeeds
    And the created task belongs to the configured project
