import { describe, expect, it } from "vitest";
import {
  canonicalPath,
  captureHunk,
  findRow,
  parsePatch,
  projectToolRowToWorktree,
  projectWorktreeRowToToolCall,
  resolveSelection,
  shiftBackward,
  shiftForward,
  shiftNewToOld,
  shiftOldToNew,
  spanRows,
  type FilePatch,
  type RowTarget,
  type ToolPatch,
} from "./diffLineMapper";
import { filePatch, numbered } from "./diffPatchBuilder.test.helpers";

const BASE = numbered("l", 20);

function insertAt(lines: string[], index: number, ...added: string[]) {
  return [...lines.slice(0, index), ...added, ...lines.slice(index)];
}
function removeAt(lines: string[], index: number, count = 1) {
  return [...lines.slice(0, index), ...lines.slice(index + count)];
}

function chainOf(...patches: string[]): ToolPatch[] {
  return patches.map((patch, i) => ({
    id: `t${i + 1}`,
    files: parsePatch(patch),
  }));
}

function file(files: readonly FilePatch[], path: string): FilePatch {
  const found = files.find((f) => canonicalPath(f) === path);
  if (!found) throw new Error(`no file ${path}`);
  return found;
}

function rowOf(
  files: readonly FilePatch[],
  path: string,
  side: "old" | "new",
  line: number
) {
  const f = file(files, path);
  const location = findRow(f, side, line);
  if (!location) throw new Error(`no ${side} line ${line} in ${path}`);
  return { file: f, row: location.row };
}

function toolToWorktree(
  chain: ToolPatch[],
  index: number,
  worktree: FilePatch[],
  path: string,
  side: "old" | "new",
  line: number
): RowTarget | null {
  const { file: f, row } = rowOf(chain[index].files, path, side, line);
  return projectToolRowToWorktree(chain, index, f, row, worktree);
}

describe("parsePatch", () => {
  it("reads paths, hunk headers with optional counts and row numbers", () => {
    const [f] = parsePatch(
      [
        "diff --git a/src/a.ts b/src/a.ts",
        "--- a/src/a.ts",
        "+++ b/src/a.ts",
        "@@ -3,2 +3,3 @@ fn()",
        "-old",
        "+new",
        "+more",
        " tail",
        "",
      ].join("\n")
    );
    expect(f.oldPath).toBe("src/a.ts");
    expect(f.newPath).toBe("src/a.ts");
    const hunk = f.hunks[0];
    expect(hunk.header).toBe("@@ -3,2 +3,3 @@ fn()");
    expect([
      hunk.oldStart,
      hunk.oldCount,
      hunk.newStart,
      hunk.newCount,
    ]).toEqual([3, 2, 3, 3]);
    expect(
      hunk.rows.map((r) => [r.kind, r.text, r.oldLine, r.newLine])
    ).toEqual([
      ["del", "old", 3, null],
      ["add", "new", null, 3],
      ["add", "more", null, 4],
      ["context", "tail", 4, 5],
    ]);
  });

  it("treats a removed line that looks like a file header as a row", () => {
    const [f] = parsePatch(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,2 +1 @@\n--- not a header\n keep\n"
    );
    expect(f.hunks[0].rows.map((r) => r.text)).toEqual([
      "-- not a header",
      "keep",
    ]);
    expect(f.hunks[0].rows[0].kind).toBe("del");
  });

  it("marks rows followed by a no-newline marker", () => {
    const [f] = parsePatch(
      "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n\\ No newline at end of file\n+b\n"
    );
    expect(f.hunks[0].rows.map((r) => r.noNewline)).toEqual([true, false]);
  });

  it("reads added, deleted and renamed files and several files", () => {
    const files = parsePatch(
      filePatch({ path: "n.ts", before: null, after: ["a"] }) +
        filePatch({ path: "d.ts", before: ["a"], after: null }) +
        filePatch({
          oldPath: "o.ts",
          path: "r.ts",
          before: ["a", "b"],
          after: ["a", "c"],
        })
    );
    expect(files.map((f) => [f.oldPath, f.newPath])).toEqual([
      [null, "n.ts"],
      ["d.ts", null],
      ["o.ts", "r.ts"],
    ]);
    expect(files[0].hunks[0].header).toBe("@@ -0,0 +1 @@");
    expect(files[1].hunks[0].header).toBe("@@ -1 +0,0 @@");
  });

  it("reads a rename without hunks and a quoted path", () => {
    const files = parsePatch(
      [
        "diff --git a/old.ts b/new.ts",
        "similarity index 100%",
        "rename from old.ts",
        "rename to new.ts",
        'diff --git "a/sp\\303\\251 \\"q\\".ts" "b/sp\\303\\251 \\"q\\".ts"',
        'rename from "sp\\303\\251 \\"q\\".ts"',
        'rename to "sp\\303\\251 \\"q\\".ts"',
        "",
      ].join("\n")
    );
    expect(files[0]).toMatchObject({ oldPath: "old.ts", newPath: "new.ts" });
    expect(files[1].newPath).toBe('spé "q".ts');
  });

  it("starts a file at a bare --- line without a diff --git header", () => {
    const files = parsePatch(
      "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n--- a/y\n+++ b/y\n@@ -1 +1 @@\n-c\n+d\n"
    );
    expect(files.map(canonicalPath)).toEqual(["x", "y"]);
  });

  it("tolerates garbage and empty input", () => {
    expect(parsePatch("")).toEqual([]);
    expect(parsePatch("hello\nworld")).toEqual([]);
  });
});

describe("single patch shifting", () => {
  // Insert 2 lines after l5 and delete l12..l14 (three lines).
  const after = removeAt(insertAt(BASE, 5, "x1", "x2"), 13, 3);
  const [f] = parsePatch(filePatch({ path: "f", before: BASE, after }));

  it("keeps lines above a hunk and shifts lines below by added - removed", () => {
    expect(shiftOldToNew(f, 1)).toEqual({ kind: "same", line: 1 });
    expect(shiftOldToNew(f, 5)).toEqual({ kind: "same", line: 5 });
    expect(shiftOldToNew(f, 6)).toEqual({ kind: "same", line: 8 });
    expect(shiftOldToNew(f, 20)).toEqual({ kind: "same", line: 19 });
    expect(shiftNewToOld(f, 8)).toEqual({ kind: "same", line: 6 });
    expect(shiftNewToOld(f, 19)).toEqual({ kind: "same", line: 20 });
  });

  it("maps context rows inside hunks and reports changed rows", () => {
    expect(shiftOldToNew(f, 4)).toEqual({ kind: "same", line: 4 });
    expect(shiftOldToNew(f, 12)).toEqual({ kind: "changed" });
    expect(shiftOldToNew(f, 13)).toEqual({ kind: "changed" });
    expect(shiftNewToOld(f, 6)).toEqual({ kind: "changed" });
    expect(shiftNewToOld(f, 7)).toEqual({ kind: "changed" });
  });

  it("leaves files the patch does not touch unchanged", () => {
    expect(shiftOldToNew(undefined, 7)).toEqual({ kind: "same", line: 7 });
    expect(shiftNewToOld(undefined, 7)).toEqual({ kind: "same", line: 7 });
  });

  it("handles hunks at the start and at the end of a file", () => {
    const [start] = parsePatch(
      filePatch({
        path: "f",
        before: BASE,
        after: ["top", ...BASE.slice(0, 19)],
      })
    );
    // top inserted, l20 removed
    expect(shiftOldToNew(start, 1)).toEqual({ kind: "same", line: 2 });
    expect(shiftOldToNew(start, 20)).toEqual({ kind: "changed" });
    expect(shiftNewToOld(start, 1)).toEqual({ kind: "changed" });
    expect(shiftNewToOld(start, 20)).toEqual({ kind: "same", line: 19 });
  });

  it("maps every line of a deleted or added file as changed", () => {
    const [deleted] = parsePatch(
      filePatch({ path: "f", before: ["a"], after: null })
    );
    const [added] = parsePatch(
      filePatch({ path: "f", before: null, after: ["a"] })
    );
    expect(shiftOldToNew(deleted, 1)).toEqual({ kind: "changed" });
    expect(shiftNewToOld(added, 1)).toEqual({ kind: "changed" });
  });

  it("handles pure insertion and pure deletion hunks with zero counts", () => {
    const [ins] = parsePatch(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -5,0 +6,3 @@\n+a\n+b\n+c\n"
    );
    expect(shiftOldToNew(ins, 5)).toEqual({ kind: "same", line: 5 });
    expect(shiftOldToNew(ins, 6)).toEqual({ kind: "same", line: 9 });
    const [del] = parsePatch(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -5,2 +4,0 @@\n-a\n-b\n"
    );
    expect(shiftOldToNew(del, 4)).toEqual({ kind: "same", line: 4 });
    expect(shiftOldToNew(del, 7)).toEqual({ kind: "same", line: 5 });
    expect(shiftNewToOld(del, 5)).toEqual({ kind: "same", line: 7 });
  });
});

describe("landing rules", () => {
  // t1 inserts X after l5; t2 inserts Y after l2 and deletes l10; t3 appends Z.
  const s0 = BASE;
  const s1 = insertAt(s0, 5, "X");
  const s2 = removeAt(insertAt(s1, 2, "Y"), 11);
  const s3 = [...s2, "Z"];
  const chain = chainOf(
    filePatch({ path: "f", before: s0, after: s1 }),
    filePatch({ path: "f", before: s1, after: s2 }),
    filePatch({ path: "f", before: s2, after: s3 })
  );
  const worktree = parsePatch(filePatch({ path: "f", before: s0, after: s3 }));

  it("lands a + line of call T on the same + line, shifted forward", () => {
    // X is line 6 in t1 and line 7 in the working tree (Y was inserted above).
    const target = toolToWorktree(chain, 0, worktree, "f", "new", 6);
    expect(target?.location.row).toMatchObject({
      kind: "add",
      text: "X",
      newLine: 7,
    });
    expect(target?.patchIndex).toBe(-1);
  });

  it("does not show a + line in All Changes when a later call removed it", () => {
    const removed = chainOf(
      filePatch({ path: "f", before: s0, after: s1 }),
      filePatch({ path: "f", before: s1, after: s0 })
    );
    const wt = parsePatch(filePatch({ path: "f", before: s0, after: s0 }));
    expect(toolToWorktree(removed, 0, wt, "f", "new", 6)).toBeNull();
  });

  it("lands a - line of call T on the same - line, shifted back", () => {
    // t2 deletes l10, which is line 12 of t2's old side (X and none above... )
    const del = chain[1].files[0].hunks
      .flatMap((h) => h.rows)
      .find((r) => r.kind === "del")!;
    expect(del.text).toBe("l10");
    const target = projectToolRowToWorktree(
      chain,
      1,
      chain[1].files[0],
      del,
      worktree
    );
    expect(target?.location.row).toMatchObject({
      kind: "del",
      text: "l10",
      oldLine: 10,
    });
  });

  it("does not show a - line in All Changes when an earlier call added it", () => {
    const transient = chainOf(
      filePatch({ path: "f", before: s0, after: s1 }),
      filePatch({ path: "f", before: s1, after: s0 })
    );
    const wt = parsePatch(filePatch({ path: "f", before: s0, after: s0 }));
    expect(toolToWorktree(transient, 1, wt, "f", "old", 6)).toBeNull();
  });

  it("lands a context line of call T on its new-side line when All Changes shows it", () => {
    // l3 is context in t1 (new line 3); in the working tree it is line 4.
    const target = toolToWorktree(chain, 0, worktree, "f", "new", 3);
    expect(target?.location.row).toMatchObject({
      kind: "context",
      text: "l3",
      newLine: 4,
    });
  });

  it("drops a context line that All Changes has no hunk for", () => {
    const wt = parsePatch(
      filePatch({ path: "f", before: s0, after: s3, context: 0 })
    );
    expect(toolToWorktree(chain, 0, wt, "f", "new", 3)).toBeNull();
  });

  it("lands a + line of All Changes on the call that added it", () => {
    const { file: f, row } = rowOf(worktree, "f", "new", 7);
    expect(row.text).toBe("X");
    const target = projectWorktreeRowToToolCall(chain, f, row);
    expect(target?.patchIndex).toBe(0);
    expect(target?.location.row).toMatchObject({ kind: "add", newLine: 6 });
    const z = rowOf(worktree, "f", "new", 22);
    expect(z.row.text).toBe("Z");
    expect(projectWorktreeRowToToolCall(chain, z.file, z.row)?.patchIndex).toBe(
      2
    );
  });

  it("lands a - line of All Changes on the call that removed it", () => {
    const { file: f, row } = rowOf(worktree, "f", "old", 10);
    expect(row.text).toBe("l10");
    const target = projectWorktreeRowToToolCall(chain, f, row);
    expect(target?.patchIndex).toBe(1);
    expect(target?.location.row).toMatchObject({ kind: "del", oldLine: 11 });
  });

  it("shows no inline copy of a - line removed before the session", () => {
    // Baseline moved after a commit: All Changes deletes a line no call did.
    const wt = parsePatch(
      filePatch({ path: "f", before: s0, after: removeAt(s0, 3) })
    );
    const { file: f, row } = rowOf(wt, "f", "old", 4);
    expect(projectWorktreeRowToToolCall(chain, f, row)).toBeNull();
  });

  it("has no producing call for a context row of All Changes", () => {
    const { file: f, row } = rowOf(worktree, "f", "new", 4);
    expect(row.kind).toBe("context");
    expect(projectWorktreeRowToToolCall(chain, f, row)).toBeNull();
  });

  it("refuses a mapped line whose text differs (moved baseline)", () => {
    // The baseline of All Changes was rewritten, so line 7 holds other text.
    const other = [...s0];
    other[5] = "unrelated";
    const wt = parsePatch(filePatch({ path: "f", before: other, after: s3 }));
    expect(toolToWorktree(chain, 0, wt, "f", "new", 6)).not.toBeNull();
    const added = rowOf(wt, "f", "new", 7);
    expect(added.row.text).toBe("X");
    const moved = chainOf(
      filePatch({ path: "f", before: s0, after: insertAt(s0, 5, "W") })
    );
    expect(
      projectWorktreeRowToToolCall(moved, added.file, added.row)
    ).toBeNull();
  });
});

describe("chains", () => {
  it("follows a rename between tool calls in both directions", () => {
    const a = numbered("a", 8);
    const a1 = insertAt(a, 2, "N");
    const a2 = removeAt(a1, 6);
    const chain = chainOf(
      filePatch({ path: "old.ts", before: a, after: a1 }),
      filePatch({ oldPath: "old.ts", path: "new.ts", before: a1, after: a2 })
    );
    const worktree = parsePatch(
      filePatch({
        oldPath: "old.ts",
        path: "new.ts",
        before: a,
        after: a2,
      })
    );
    // N: line 3 in t1 (old.ts); still line 3 in new.ts.
    const target = toolToWorktree(chain, 0, worktree, "old.ts", "new", 3);
    expect(target?.file.newPath).toBe("new.ts");
    expect(target?.location.row).toMatchObject({ kind: "add", newLine: 3 });
    // And back: All Changes + N belongs to t1 (path old.ts).
    const { file: f, row } = rowOf(worktree, "new.ts", "new", 3);
    const back = projectWorktreeRowToToolCall(chain, f, row);
    expect(back?.patchIndex).toBe(0);
    expect(back?.file.newPath).toBe("old.ts");
    // The - line of t2 (a5, old line 6 in t2, line 5 at baseline).
    const del = chain[1].files[0].hunks[0].rows.find((r) => r.kind === "del")!;
    const mapped = projectToolRowToWorktree(
      chain,
      1,
      chain[1].files[0],
      del,
      worktree
    );
    expect(mapped?.location.row).toMatchObject({ kind: "del", oldLine: 6 });
  });

  it("treats a file added by a call as absent before it and deleted after", () => {
    const chain = chainOf(
      filePatch({ path: "n.ts", before: null, after: ["a", "b"] }),
      filePatch({ path: "n.ts", before: ["a", "b"], after: null })
    );
    expect(shiftBackward(chain, 1, "n.ts", 1)).toEqual({
      ok: false,
      reason: "added",
    });
    expect(shiftForward(chain, 1, "n.ts", 1)).toEqual({
      ok: false,
      reason: "removed",
    });
    expect(shiftForward(chain, 0, "n.ts", 1)).toEqual({
      ok: false,
      reason: "removed",
    });
    expect(shiftBackward(chain, 0, "other.ts", 4)).toEqual({
      ok: true,
      path: "other.ts",
      line: 4,
    });
  });

  it("lands added-file lines on the added file of All Changes", () => {
    const chain = chainOf(
      filePatch({ path: "n.ts", before: null, after: ["a", "b", "c"] })
    );
    const worktree = parsePatch(
      filePatch({ path: "n.ts", before: null, after: ["a", "b", "c"] })
    );
    const target = toolToWorktree(chain, 0, worktree, "n.ts", "new", 2);
    expect(target?.location.row).toMatchObject({ kind: "add", text: "b" });
  });

  it("lands deleted-file lines on the deleted file of All Changes", () => {
    const chain = chainOf(
      filePatch({ path: "d.ts", before: ["a", "b"], after: null })
    );
    const worktree = parsePatch(
      filePatch({ path: "d.ts", before: ["a", "b"], after: null })
    );
    const target = toolToWorktree(chain, 0, worktree, "d.ts", "old", 2);
    expect(target?.location.row).toMatchObject({ kind: "del", text: "b" });
    const { file: f, row } = rowOf(worktree, "d.ts", "old", 1);
    expect(projectWorktreeRowToToolCall(chain, f, row)?.patchIndex).toBe(0);
  });

  it("maps across several hunks of one file", () => {
    const before = numbered("m", 40);
    const mid = insertAt(before, 2, "p"); // hunk at the start
    const after = removeAt(mid, 30); // far hunk
    const chain = chainOf(
      filePatch({ path: "f", before, after: mid }),
      filePatch({ path: "f", before: mid, after })
    );
    expect(chain[1].files[0].hunks).toHaveLength(1);
    const worktree = parsePatch(filePatch({ path: "f", before, after }));
    expect(worktree[0].hunks).toHaveLength(2);
    const target = toolToWorktree(chain, 0, worktree, "f", "new", 3);
    expect(target?.location.row).toMatchObject({ kind: "add", text: "p" });
    const second = toolToWorktree(chain, 1, worktree, "f", "old", 31);
    expect(second?.location.row).toMatchObject({ kind: "del", oldLine: 30 });
  });

  it("keeps a no-newline marker out of line numbering", () => {
    const patch =
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -2,2 +2,2 @@\n a\n-b\n\\ No newline at end of file\n+c\n\\ No newline at end of file\n";
    const [f] = parsePatch(patch);
    expect(f.hunks[0].rows.map((r) => [r.kind, r.oldLine, r.newLine])).toEqual([
      ["context", 2, 2],
      ["del", 3, null],
      ["add", null, 3],
    ]);
    expect(shiftOldToNew(f, 10)).toEqual({ kind: "same", line: 10 });
  });
});

describe("selections and hunk capture", () => {
  const after = [...BASE.slice(0, 9), "n1", "n2", ...BASE.slice(11)];
  const [f] = parsePatch(filePatch({ path: "f", before: BASE, after }));

  it("takes the side of the row at the end of the selection", () => {
    expect(
      resolveSelection(
        f,
        { side: "additions", line: 10 },
        { side: "additions", line: 11 }
      )
    ).toEqual({ side: "new", startLine: 10, endLine: 11 });
    expect(
      resolveSelection(
        f,
        { side: "deletions", line: 10 },
        { side: "deletions", line: 11 }
      )
    ).toEqual({ side: "old", startLine: 10, endLine: 11 });
  });

  it("puts a context line on the new side even when selected on the old side", () => {
    expect(
      resolveSelection(
        f,
        { side: "deletions", line: 8 },
        { side: "deletions", line: 8 }
      )
    ).toEqual({ side: "new", startLine: 8, endLine: 8 });
  });

  it("treats a reversed drag as the same selection", () => {
    expect(
      resolveSelection(
        f,
        { side: "additions", line: 11 },
        { side: "additions", line: 10 }
      )
    ).toEqual({ side: "new", startLine: 10, endLine: 11 });
    expect(
      resolveSelection(
        f,
        { side: "deletions", line: 11 },
        { side: "deletions", line: 10 }
      )
    ).toEqual({ side: "old", startLine: 10, endLine: 11 });
  });

  it("keeps a selection that crosses sides, starting at the first row with a number on the end side", () => {
    // Start on the added n1 (new 10), end on the deleted l11 (old 11): the
    // later row in the patch is n1, so the span is on the new side.
    expect(
      resolveSelection(
        f,
        { side: "additions", line: 10 },
        { side: "deletions", line: 11 }
      )
    ).toEqual({ side: "new", startLine: 10, endLine: 10 });
    // Start on a deleted row, end on an added row: new side from the first
    // row that has a new number.
    expect(
      resolveSelection(
        f,
        { side: "deletions", line: 10 },
        { side: "additions", line: 11 }
      )
    ).toEqual({ side: "new", startLine: 10, endLine: 11 });
    // Context start (old 8) to a deleted end: old side keeps the context rows.
    expect(
      resolveSelection(
        f,
        { side: "additions", line: 8 },
        { side: "deletions", line: 11 }
      )
    ).toEqual({ side: "old", startLine: 8, endLine: 11 });
  });

  it("clamps a selection across hunks to the later hunk without dropping it", () => {
    const wide = [
      ...BASE.slice(0, 2),
      "a",
      ...BASE.slice(2, 17),
      "b",
      ...BASE.slice(17),
    ];
    const [g] = parsePatch(filePatch({ path: "f", before: BASE, after: wide }));
    expect(g.hunks.length).toBeGreaterThan(1);
    const second = g.hunks[1].rows.filter((r) => r.newLine !== null);
    const firstRow = second[0];
    const lastRow = second[second.length - 1];
    expect(
      resolveSelection(
        g,
        { side: "additions", line: 3 },
        { side: "additions", line: lastRow.newLine! }
      )
    ).toEqual({
      side: "new",
      startLine: firstRow.newLine,
      endLine: lastRow.newLine,
    });
  });

  it("ignores an endpoint outside the patch but keeps the other", () => {
    expect(
      resolveSelection(
        f,
        { side: "additions", line: 1 },
        { side: "additions", line: 10 }
      )
    ).toEqual({ side: "new", startLine: 10, endLine: 10 });
    expect(
      resolveSelection(
        f,
        { side: "additions", line: 11 },
        { side: "additions", line: 1 }
      )
    ).toEqual({ side: "new", startLine: 11, endLine: 11 });
  });

  it("returns null only when no endpoint is in the patch", () => {
    expect(
      resolveSelection(
        f,
        { side: "additions", line: 1 },
        { side: "additions", line: 2 }
      )
    ).toBeNull();
  });

  it("captures the hunk from its header through the last commented row", () => {
    expect(captureHunk(f, "new", 10)).toBe(
      ["@@ -7,8 +7,8 @@", " l7", " l8", " l9", "-l10", "-l11", "+n1"].join("\n")
    );
  });

  it("includes a no-newline marker with its row", () => {
    const [g] = parsePatch(
      "diff --git a/f b/f\n--- a/f\n+++ b/f\n@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file\n"
    );
    expect(captureHunk(g, "new", 1)).toBe(
      "@@ -1 +1 @@\n-a\n+b\n\\ No newline at end of file"
    );
  });

  it("returns null when the line is not in the patch", () => {
    expect(captureHunk(f, "new", 1)).toBeNull();
  });

  it("lists the rows of a span only when every line is shown", () => {
    expect(
      spanRows(f, { side: "new", startLine: 10, endLine: 11 })?.map(
        (r) => r.text
      )
    ).toEqual(["n1", "n2"]);
    expect(spanRows(f, { side: "new", startLine: 1, endLine: 2 })).toBeNull();
  });
});
