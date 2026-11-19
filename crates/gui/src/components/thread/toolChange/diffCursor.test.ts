import { describe, expect, it } from "vitest";
import {
  moveCursor,
  moveToLandmark,
  selectedCode,
  switchCursorSide,
} from "./diffCursor";
import { parsePatch } from "./diffLineMapper";
import { filePatch, numbered } from "./diffPatchBuilder.test.helpers";

const BASE = numbered("a", 10);
// a.ts: line 5 "a5" becomes "A5" (one deletion, one addition).
const A = parsePatch(
  filePatch({
    path: "a.ts",
    before: BASE,
    after: BASE.map((line) => (line === "a5" ? "A5" : line)),
  })
)[0];
const B = parsePatch(
  filePatch({ path: "b.ts", before: ["b1", "b2"], after: ["b1", "b2", "b3"] })
)[0];
const FILES = [A, B];

const at = (path: string, line: number, side = "additions" as const) => ({
  path,
  range: { start: line, end: line, side },
});

describe("moveCursor", () => {
  it("starts on the first line of the first file", () => {
    expect(moveCursor(FILES, "unified", null, 1, false)).toEqual(at("a.ts", 2));
  });

  it("visits the removed row in a unified diff", () => {
    const next = moveCursor(FILES, "unified", at("a.ts", 4), 1, false);
    expect(next).toEqual({
      path: "a.ts",
      range: { start: 5, end: 5, side: "deletions" },
    });
    expect(moveCursor(FILES, "unified", next, 1, false)).toEqual(at("a.ts", 5));
  });

  it("moves past the last line of a file to the first line of the next", () => {
    const last = A.hunks.at(-1)!.rows.at(-1)!.newLine!;
    expect(moveCursor(FILES, "unified", at("a.ts", last), 1, false)).toEqual(
      at("b.ts", 1)
    );
    expect(moveCursor(FILES, "unified", at("b.ts", 1), -1, false)).toEqual(
      at("a.ts", last)
    );
  });

  it("extends a range from its anchor and stops at the file edge", () => {
    let current = moveCursor(FILES, "unified", at("b.ts", 1), 1, true);
    current = moveCursor(FILES, "unified", current, 1, true);
    expect(current).toEqual({
      path: "b.ts",
      range: { start: 1, end: 3, side: "additions" },
    });
    expect(moveCursor(FILES, "unified", current, 1, true)).toBe(current);
  });

  it("walks one column in a split diff", () => {
    expect(moveCursor(FILES, "split", at("a.ts", 4), 1, false)).toEqual(
      at("a.ts", 5)
    );
  });
});

describe("switchCursorSide", () => {
  it("moves to the same row on the other column", () => {
    expect(
      switchCursorSide(FILES, "split", at("a.ts", 5), "deletions")
    ).toEqual({ path: "a.ts", range: { start: 5, end: 5, side: "deletions" } });
  });

  it("finds the nearest row with a line on the other column", () => {
    expect(
      switchCursorSide(FILES, "split", at("b.ts", 3), "deletions")
    ).toEqual({ path: "b.ts", range: { start: 2, end: 2, side: "deletions" } });
  });

  it("is a no-op in a unified diff", () => {
    const current = at("a.ts", 5);
    expect(switchCursorSide(FILES, "unified", current, "deletions")).toBe(
      current
    );
  });
});

describe("selectedCode", () => {
  it("copies exactly the selected rows without markers or line numbers", () => {
    expect(
      selectedCode(B, "unified", { start: 1, end: 3, side: "additions" })
    ).toBe("b1\nb2\nb3");
  });

  it("includes removed rows shown between the ends of a unified range", () => {
    expect(
      selectedCode(A, "unified", { start: 4, end: 5, side: "additions" })
    ).toBe("a4\na5\nA5");
  });

  it("keeps a reversed range in display order", () => {
    expect(
      selectedCode(B, "unified", { start: 3, end: 1, side: "additions" })
    ).toBe("b1\nb2\nb3");
  });

  it("copies one column of a split diff", () => {
    expect(
      selectedCode(A, "split", { start: 4, end: 6, side: "deletions" })
    ).toBe("a4\na5\na6");
  });
});

describe("moveToLandmark", () => {
  // Two separate changes far apart: two hunks in one file.
  const LONG = numbered("c", 40);
  const C = parsePatch(
    filePatch({
      path: "c.ts",
      before: LONG,
      after: LONG.map((line) =>
        line === "c5" ? "C5" : line === "c30" ? "C30" : line
      ),
    })
  )[0];
  const MANY = [C, B];
  const hunkStarts = C.hunks.map((hunk) => hunk.newStart);

  it("jumps between hunk starts, then into the next file", () => {
    expect(C.hunks).toHaveLength(2);
    let cursor = moveToLandmark(MANY, "unified", null, 1);
    expect(cursor).toEqual(at("c.ts", hunkStarts[0]));
    cursor = moveToLandmark(MANY, "unified", cursor, 1);
    expect(cursor).toEqual(at("c.ts", hunkStarts[1]));
    cursor = moveToLandmark(MANY, "unified", cursor, 1);
    expect(cursor).toEqual(at("b.ts", 1));
    expect(moveToLandmark(MANY, "unified", cursor, 1)).toBeNull();
    expect(moveToLandmark(MANY, "unified", cursor, -1)).toEqual(
      at("c.ts", hunkStarts[1])
    );
  });

  it("stops on commented lines between hunk starts", () => {
    const start = at("c.ts", hunkStarts[0]);
    const next = moveToLandmark(MANY, "unified", start, 1, {
      marks: (path) => (path === "c.ts" ? [{ side: "additions", line: 6 }] : []),
    });
    expect(next).toEqual(at("c.ts", 6));
  });

  it("visits only file starts with filesOnly", () => {
    const inSecondHunk = at("c.ts", hunkStarts[1]);
    expect(
      moveToLandmark(MANY, "unified", inSecondHunk, 1, { filesOnly: true })
    ).toEqual(at("b.ts", 1));
    expect(
      moveToLandmark(MANY, "unified", inSecondHunk, -1, { filesOnly: true })
    ).toEqual(at("c.ts", hunkStarts[0]));
  });
});
