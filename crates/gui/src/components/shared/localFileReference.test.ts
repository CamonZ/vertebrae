import { describe, expect, it } from "vitest";
import { parseLocalFileReference } from "./localFileReference";

describe("parseLocalFileReference", () => {
  it("accepts repository-relative paths with line and column locations", () => {
    expect(parseLocalFileReference("src/main.rs:12:4", "/repo")).toEqual({
      path: "src/main.rs",
      line: 12,
      column: 4,
    });
    expect(parseLocalFileReference("src/main.rs#L12C4", "/repo")).toEqual({
      path: "src/main.rs",
      line: 12,
      column: 4,
    });
  });

  it("accepts absolute paths only in an authorized project or worktree root", () => {
    expect(parseLocalFileReference("/repo/src/main.rs:12", "/repo")).not.toBe(
      null
    );
    expect(
      parseLocalFileReference("/other/worktree/main.rs", "/repo")
    ).toBeNull();
    expect(
      parseLocalFileReference("/other/worktree/main.rs", "/repo", [
        "/other/worktree",
      ])
    ).not.toBeNull();
    expect(parseLocalFileReference("../other/main.rs", "/repo")).toBeNull();
    expect(parseLocalFileReference("Dockerfile", "/repo")).not.toBeNull();
  });

  it("rejects protocols and prose that only looks like code", () => {
    expect(parseLocalFileReference("file:///repo/main.rs", "/repo")).toBeNull();
    expect(parseLocalFileReference("vscode://file/repo/main.rs", "/repo")).toBeNull();
    expect(parseLocalFileReference("console.log()", "/repo")).toBeNull();
  });
});
