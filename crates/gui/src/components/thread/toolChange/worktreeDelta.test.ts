import { describe, expect, it } from "vitest";
import { parseWorktreeDelta } from "./worktreeDelta";

const PATCH = `diff --git a/a.txt b/a.txt
index 1..2 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 keep
-old
+new
+extra
`;

describe("parseWorktreeDelta", () => {
  it("derives counts from hunks, excluding headers", () => {
    const d = parseWorktreeDelta({
      patch: PATCH,
      files: [{ path: "a.txt", status: "modified" }],
    });
    expect(d?.files[0]).toMatchObject({ additions: 2, deletions: 1 });
  });

  it("leaves counts unset for marker-only files", () => {
    const d = parseWorktreeDelta({
      patch: "",
      files: [{ path: "b.bin", status: "added", marker: { reason: "binary" } }],
    });
    expect(d?.files[0].additions).toBeUndefined();
    expect(d?.files[0].marker).toBe("binary");
  });

  it("treats a null marker as absent", () => {
    const d = parseWorktreeDelta({
      patch: PATCH,
      files: [{ path: "a.txt", status: "modified", marker: null }],
    });
    expect(d?.files[0]).toMatchObject({ additions: 2, deletions: 1 });
    expect(d?.files[0].marker).toBeUndefined();
  });

  it("keeps pure renames without hunks", () => {
    const d = parseWorktreeDelta({
      patch:
        "diff --git a/o b/n\nsimilarity index 100%\nrename from o\nrename to n\n",
      files: [{ path: "n", old_path: "o", status: "renamed" }],
    });
    expect(d?.files[0]).toMatchObject({ oldPath: "o", additions: 0 });
  });

  it("rejects malformed payloads and empty deltas", () => {
    expect(parseWorktreeDelta(null)).toBeNull();
    expect(parseWorktreeDelta({ files: "x" })).toBeNull();
    expect(
      parseWorktreeDelta({ files: [{ path: "a", status: "weird" }] })
    ).toBeNull();
    expect(parseWorktreeDelta({ files: [], patch: "" })).toBeNull();
    expect(
      parseWorktreeDelta({
        files: [{ path: "a", status: "added", marker: "binary" }],
      })
    ).toBeNull();
    expect(
      parseWorktreeDelta({
        files: [{ path: "a", status: "added", marker: { reason: "nope" } }],
      })
    ).toBeNull();
  });

  it("carries aggregate and overlapping flags", () => {
    const d = parseWorktreeDelta({
      patch: PATCH,
      files: [{ path: "a.txt", status: "modified" }],
      aggregate: true,
      overlapping: true,
    });
    expect(d).toMatchObject({ aggregate: true, overlapping: true });
  });
});
