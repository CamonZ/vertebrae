import { describe, expect, it } from "vitest";
import {
  gapScrollPoint,
  moveCursor,
  moveToLandmark,
  selectedCode,
  switchCursorSide,
  type CursorView,
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

const UNIFIED: CursorView = { layout: "unified" };
const SPLIT: CursorView = { layout: "split" };

const at = (path: string, line: number, side = "additions" as const) => ({
  kind: "line" as const,
  path,
  range: { start: line, end: line, side },
});

describe("moveCursor", () => {
  it("starts on the first line of the first file", () => {
    expect(moveCursor(FILES, UNIFIED, null, 1, false)).toEqual(at("a.ts", 2));
  });

  it("visits the removed row in a unified diff", () => {
    const next = moveCursor(FILES, UNIFIED, at("a.ts", 4), 1, false);
    expect(next).toEqual({
      kind: "line",
      path: "a.ts",
      range: { start: 5, end: 5, side: "deletions" },
    });
    expect(moveCursor(FILES, UNIFIED, next, 1, false)).toEqual(at("a.ts", 5));
  });

  it("moves past the last line of a file to the first line of the next", () => {
    const last = A.hunks.at(-1)!.rows.at(-1)!.newLine!;
    expect(moveCursor(FILES, UNIFIED, at("a.ts", last), 1, false)).toEqual(
      at("b.ts", 1)
    );
    expect(moveCursor(FILES, UNIFIED, at("b.ts", 1), -1, false)).toEqual(
      at("a.ts", last)
    );
  });

  it("extends a range from its anchor and stops at the file edge", () => {
    let current = moveCursor(FILES, UNIFIED, at("b.ts", 1), 1, true);
    current = moveCursor(FILES, UNIFIED, current, 1, true);
    expect(current).toEqual({
      kind: "line",
      path: "b.ts",
      range: { start: 1, end: 3, side: "additions" },
    });
    expect(moveCursor(FILES, UNIFIED, current, 1, true)).toBe(current);
  });

  it("walks one column in a split diff", () => {
    expect(moveCursor(FILES, SPLIT, at("a.ts", 4), 1, false)).toEqual(
      at("a.ts", 5)
    );
  });
});

describe("switchCursorSide", () => {
  it("moves to the same row on the other column", () => {
    expect(
      switchCursorSide(FILES, SPLIT, at("a.ts", 5), "deletions")
    ).toEqual({
      kind: "line",
      path: "a.ts",
      range: { start: 5, end: 5, side: "deletions" },
    });
  });

  it("finds the nearest row with a line on the other column", () => {
    expect(
      switchCursorSide(FILES, SPLIT, at("b.ts", 3), "deletions")
    ).toEqual({
      kind: "line",
      path: "b.ts",
      range: { start: 2, end: 2, side: "deletions" },
    });
  });

  it("is a no-op in a unified diff", () => {
    const current = at("a.ts", 5);
    expect(switchCursorSide(FILES, UNIFIED, current, "deletions")).toBe(
      current
    );
  });
});

describe("selectedCode", () => {
  it("copies exactly the selected rows without markers or line numbers", () => {
    expect(
      selectedCode(B, UNIFIED, { start: 1, end: 3, side: "additions" })
    ).toBe("b1\nb2\nb3");
  });

  it("includes removed rows shown between the ends of a unified range", () => {
    expect(
      selectedCode(A, UNIFIED, { start: 4, end: 5, side: "additions" })
    ).toBe("a4\na5\nA5");
  });

  it("keeps a reversed range in display order", () => {
    expect(
      selectedCode(B, UNIFIED, { start: 3, end: 1, side: "additions" })
    ).toBe("b1\nb2\nb3");
  });

  it("copies one column of a split diff", () => {
    expect(
      selectedCode(A, SPLIT, { start: 4, end: 6, side: "deletions" })
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
    let cursor = moveToLandmark(MANY, UNIFIED, null, 1);
    expect(cursor).toEqual(at("c.ts", hunkStarts[0]));
    cursor = moveToLandmark(MANY, UNIFIED, cursor, 1);
    expect(cursor).toEqual(at("c.ts", hunkStarts[1]));
    cursor = moveToLandmark(MANY, UNIFIED, cursor, 1);
    expect(cursor).toEqual(at("b.ts", 1));
    expect(moveToLandmark(MANY, UNIFIED, cursor, 1)).toBeNull();
    expect(moveToLandmark(MANY, UNIFIED, cursor, -1)).toEqual(
      at("c.ts", hunkStarts[1])
    );
  });

  it("stops on commented lines between hunk starts", () => {
    const start = at("c.ts", hunkStarts[0]);
    const next = moveToLandmark(MANY, UNIFIED, start, 1, {
      marks: (path) => (path === "c.ts" ? [{ side: "additions", line: 6 }] : []),
    });
    expect(next).toEqual(at("c.ts", 6));
  });

  it("visits only file starts with filesOnly", () => {
    const inSecondHunk = at("c.ts", hunkStarts[1]);
    expect(
      moveToLandmark(MANY, UNIFIED, inSecondHunk, 1, { filesOnly: true })
    ).toEqual(at("b.ts", 1));
    expect(
      moveToLandmark(MANY, UNIFIED, inSecondHunk, -1, { filesOnly: true })
    ).toEqual(at("c.ts", hunkStarts[0]));
  });
});

describe("gap rows", () => {
  // Hunks 7–13 and 47–53 of a 60-line file: gaps above, between and below.
  const LINES = numbered("g", 60);
  const AFTER = LINES.map((line) =>
    line === "g10" ? "G10" : line === "g50" ? "G50" : line
  );
  const G = parsePatch(filePatch({ path: "g.ts", before: LINES, after: AFTER }))[0];
  const view = (revealed: [number, { top: number; bottom: number }][] = []): CursorView => ({
    layout: "unified",
    context: (path) =>
      path === "g.ts" ? { revealed: new Map(revealed), lines: AFTER } : undefined,
  });
  const gap = (index: number, arrival: -1 | 1) => ({
    kind: "gap" as const,
    path: "g.ts",
    gap: index,
    arrival,
    side: "additions" as const,
  });

  it("are not rows without a context", () => {
    expect(moveCursor([G], UNIFIED, at("g.ts", 13), 1, false)).toEqual(at("g.ts", 47));
  });

  it("steps onto the gap after a hunk's last line, and off it", () => {
    const onGap = moveCursor([G], view(), at("g.ts", 13), 1, false);
    expect(onGap).toEqual(gap(1, 1));
    expect(moveCursor([G], view(), onGap, 1, false)).toEqual(at("g.ts", 47));
    expect(moveCursor([G], view(), at("g.ts", 47), -1, false)).toEqual(gap(1, -1));
  });

  it("starts a file on the gap above its first hunk and ends on the gap below its last", () => {
    expect(moveCursor([G], view(), null, 1, false)).toEqual(gap(0, 1));
    expect(moveCursor([G], view(), null, -1, false)).toEqual(gap(2, -1));
    expect(moveCursor([G], view(), gap(2, 1), 1, false)).toEqual(gap(2, 1));
  });

  it("walks revealed lines and extends a selection into them, but not across a gap", () => {
    const revealed = view([[1, { top: 2, bottom: 0 }]]);
    expect(moveCursor([G], revealed, at("g.ts", 13), 1, false)).toEqual(at("g.ts", 14));
    let range = moveCursor([G], revealed, at("g.ts", 13), 1, true);
    range = moveCursor([G], revealed, range, 1, true);
    expect(range).toEqual({ kind: "line", path: "g.ts", range: { start: 13, end: 15, side: "additions" } });
    expect(moveCursor([G], revealed, range, 1, true)).toBe(range);
  });

  it("copies revealed lines with their text", () => {
    const revealed = view([[1, { top: 2, bottom: 0 }]]);
    expect(selectedCode(G, revealed, { start: 13, end: 15, side: "additions" })).toBe(
      "g13\ng14\ng15"
    );
  });

  it("moves on from a gap that has since closed", () => {
    const closed = view([[1, { top: 33, bottom: 0 }]]);
    expect(moveCursor([G], closed, gap(1, 1), 1, false)).toEqual(at("g.ts", 47));
    expect(moveCursor([G], closed, gap(1, 1), -1, false)).toEqual(at("g.ts", 46));
  });

  it("jumps to hunk starts from a gap, skipping revealed lines", () => {
    expect(moveToLandmark([G], view([[1, { top: 3, bottom: 3 }]]), gap(1, 1), 1)).toEqual(
      at("g.ts", 47)
    );
    expect(moveToLandmark([G], view(), gap(1, 1), -1)).toEqual(at("g.ts", 7));
  });

  it("scrolls a gap into view by its neighbouring line", () => {
    expect(gapScrollPoint([G], view(), gap(1, 1))).toEqual({ side: "additions", line: 47 });
    expect(gapScrollPoint([G], view(), gap(2, -1))).toEqual({ side: "additions", line: 53 });
  });
});
