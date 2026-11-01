import { expect, it } from "vitest";
import { gitActivity } from "./classification";

it.each([
  [
    ["-C", "/repo", "-c", "color.ui=false", "--no-pager", "diff"],
    "Git inspection",
  ],
  [["--git-dir=/repo/.git", "log", "--oneline"], "Git inspection"],
  [["-C/repo", "rev-parse", "HEAD"], "Git inspection"],
  [["show", "HEAD:src/main.rs"], "Git inspection"],
  [["branch", "-a"], "Git inspection"],
  [["branch", "--contains", "main"], "Git inspection"],
  [["branch", "new-branch"], "Git changes"],
  [["branch", "-D", "old"], "Git changes"],
  [["branch", "--set-upstream-to=origin/main"], "Git changes"],
  [["branch", "-uorigin/main"], "Git changes"],
  [["branch", "--edit-description"], "Git changes"],
  [["tag", "-a", "v1"], "Git changes"],
  [["worktree", "list"], "Git inspection"],
  [["worktree", "add", "/tmp/w", "main"], "environment management"],
  [["fetch", "origin"], "Git synchronization"],
  [["push", "--force-with-lease"], "Git synchronization"],
  [["commit", "-m", "show status"], "Git changes"],
  [["rebase", "--continue"], "Git changes"],
  [["remote", "-v"], "Git inspection"],
  [["remote", "set-url", "origin", "url"], "Git changes"],
  [["config", "--get", "remote.origin.url"], "Git inspection"],
  [["status", "--help"], "documentation"],
  [["-C", undefined, "status"], undefined],
  [["some-alias", "status"], undefined],
  [["--unknown", "status"], undefined],
])("classifies literal Git argv %j", (args, expected) => {
  expect(gitActivity("/usr/bin/git", args)).toBe(expected);
});

it.each([
  [["pr", "view", "531", "--json", "url,headRefOid"], "GitHub inspection"],
  [["-R", "owner/repo", "pr", "checks", "531"], "GitHub inspection"],
  [["pr", "--repo=owner/repo", "diff"], "GitHub inspection"],
  [["pr", "create", "--title", "view"], "GitHub changes"],
  [["pr", "merge", "531"], "GitHub changes"],
  [["pr", "checkout", "531"], "Git changes"],
  [["run", "view", "123", "--log-failed"], "GitHub inspection"],
  [["run", "rerun", "123"], "GitHub changes"],
  [["api", "repos/o/r/pulls"], "GitHub inspection"],
  [["api", "repos/o/r/pulls", "-f", "title=foo"], "GitHub changes"],
  [
    ["api", "-X", "GET", "repos/o/r/pulls", "-f", "state=all"],
    "GitHub inspection",
  ],
  [["api", "--method=DELETE", "repos/o/r/issues/1"], "GitHub changes"],
  [
    ["api", "graphql", "-f", "query=query { viewer { login } }"],
    "GitHub inspection",
  ],
  [
    ["api", "graphql", "-f", "query=mutation { deleteThing }"],
    "GitHub changes",
  ],
  [["api", "graphql", "--input", "query.json"], undefined],
  [["api", "repos/o/r/pulls", "-f", "-XGET"], "GitHub changes"],
  [["api", "repos/o/r/pulls", "--method"], undefined],
  [["custom-alias", "view"], undefined],
])("classifies literal GitHub argv %j", (args, expected) => {
  expect(gitActivity("gh", args)).toBe(expected);
});
