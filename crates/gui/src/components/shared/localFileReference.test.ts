import { describe, expect, it } from "vitest";
import {
  parseLocalFileReference,
  parseFileReferenceDestination,
} from "./localFileReference";

describe("parseLocalFileReference", () => {
  it("accepts line ranges and preserves their starting line", () => {
    expect(parseLocalFileReference("src/main.rs:8-12", "/repo")).toEqual({
      path: "src/main.rs",
      line: 8,
      column: null,
    });
    expect(parseLocalFileReference("src/main.rs:L8-12", "/repo")).toEqual({
      path: "src/main.rs",
      line: 8,
      column: null,
    });
    expect(parseLocalFileReference("src/main.rs#L8-L12", "/repo")).toEqual({
      path: "src/main.rs",
      line: 8,
      column: null,
    });
  });

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
    expect(
      parseLocalFileReference("vscode://file/repo/main.rs", "/repo")
    ).toBeNull();
    expect(parseLocalFileReference("console.log()", "/repo")).toBeNull();
  });
});

describe("shared destination identity", () => {
  it("decodes link destinations while keeping inline percent filenames literal", () => {
    expect(
      parseFileReferenceDestination(
        {
          destination: "/repo/feature/src/%C3%A9%20file.ts#L7C2",
          syntax: "link",
        },
        "/repo",
        ["/repo", "/repo/feature"]
      )
    ).toEqual({
      root: "/repo/feature",
      path: "src/é file.ts",
      line: 7,
      column: 2,
    });
    expect(
      parseFileReferenceDestination(
        { destination: "literal%20.ts", syntax: "inline" },
        "/repo",
        ["/repo"]
      )
    ).toEqual({ root: null, path: "literal%20.ts", line: null, column: null });
    expect(
      parseFileReferenceDestination(
        { destination: "/foreign/file.ts", syntax: "link" },
        "/repo",
        ["/repo"]
      )
    ).toBeNull();
  });
});

it.each(["opus-5.5", "claude-opus-5.5", "v1.2.3", "123.456"])(
  "does not infer file intent from the bare version identifier %s",
  (value) => {
    expect(parseLocalFileReference(value, "/repo")).toBeNull();
    expect(
      parseFileReferenceDestination(
        { destination: value, syntax: "inline" },
        "/repo",
        ["/repo"]
      )
    ).toBeNull();
  }
);

it.each(["src/archive.1", "/repo/archive.1", "./archive.1", "archive.1:12:3"])(
  "preserves explicit path intent for %s",
  (path) => expect(parseLocalFileReference(path, "/repo")).not.toBeNull()
);

it("preserves explicit link intent for a numeric extension", () => {
  expect(
    parseFileReferenceDestination(
      { destination: "archive.1:12:3", syntax: "link" },
      "/repo",
      ["/repo"]
    )
  ).toEqual({ root: null, path: "archive.1", line: 12, column: 3 });
});
