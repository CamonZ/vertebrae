import { describe, expect, it } from "vitest";
import {
  fileRows,
  gapEnds,
  growGap,
  hiddenLines,
  revealGap,
  type FileContext,
  type GapReveal,
} from "./diffGaps";
import { parsePatch } from "./diffLineMapper";
import { filePatch, numbered } from "./diffPatchBuilder.test.helpers";

// 60 lines; changes at 10 and 50 give hunks 7–13 and 47–53, so the gaps are
// lines 1–6 (above), 14–46 (between) and 54–60 (below, once loaded).
const BEFORE = numbered("l", 60);
const AFTER = BEFORE.map((line) =>
  line === "l10" ? "L10" : line === "l50" ? "L50" : line
);
const FILE = parsePatch(filePatch({ path: "f.ts", before: BEFORE, after: AFTER }))[0];

const context = (
  revealed: Record<number, GapReveal> = {},
  lines: readonly string[] | null = AFTER
): FileContext => ({
  revealed: new Map(Object.entries(revealed).map(([gap, reveal]) => [Number(gap), reveal])),
  lines,
});

const shape = (ctx?: FileContext) =>
  fileRows(FILE, ctx).map((row) =>
    row.kind === "gap" ? `gap${row.gap}:${row.hidden}` : row.row.newLine ?? `-${row.row.oldLine}`
  );

describe("fileRows", () => {
  it("shows only patch rows without a context", () => {
    expect(fileRows(FILE).every((row) => row.kind === "line")).toBe(true);
  });

  it("puts collapsed gaps between hunks, and below the last once loaded", () => {
    expect(FILE.hunks.map((hunk) => hunk.newStart)).toEqual([7, 47]);
    const unloaded = shape(context({}, null));
    expect(unloaded[0]).toBe("gap0:6");
    expect(unloaded).toContain("gap1:33");
    expect(unloaded.at(-1)).toBe(53);

    const loaded = shape(context());
    expect(loaded.at(-1)).toBe("gap2:7");
  });

  it("shows revealed lines at each end of a gap around its separator", () => {
    const rows = shape(context({ 1: { top: 2, bottom: 3 } }));
    const at = rows.indexOf("gap1:28");
    expect(rows.slice(at - 3, at + 5)).toEqual([13, 14, 15, "gap1:28", 44, 45, 46, 47]);
  });

  it("uses the loaded text for revealed lines", () => {
    const row = fileRows(FILE, context({ 1: { top: 1, bottom: 0 } })).find(
      (entry) => entry.kind === "line" && entry.row.newLine === 14
    );
    expect(row).toMatchObject({ kind: "line", hunk: null, row: { kind: "context", text: "l14", oldLine: 14 } });
  });

  it("drops a gap once its ends meet", () => {
    expect(shape(context({ 1: { top: 20, bottom: 13 } }))).not.toContain("gap1:0");
    expect(hiddenLines(FILE, context({ 1: { top: 20, bottom: 13 } }), 1)).toBe(0);
  });

  it("ignores reveals until the file is loaded, like Pierre", () => {
    expect(shape(context({ 1: { top: 5, bottom: 0 } }, null))).toContain("gap1:33");
  });
});

describe("gapEnds", () => {
  it("reveals the end the cursor came from, and the other with ⌥", () => {
    expect(gapEnds(FILE, 1, 1)).toEqual({ primary: "top", other: "bottom" });
    expect(gapEnds(FILE, 1, -1)).toEqual({ primary: "bottom", other: "top" });
  });

  it("has a single end above the first hunk and below the last", () => {
    expect(gapEnds(FILE, 0, 1)).toEqual({ primary: "bottom", other: null });
    expect(gapEnds(FILE, 2, -1)).toEqual({ primary: "top", other: null });
  });
});

describe("revealGap", () => {
  it("reveals a batch below the hunk above when arriving with ↓", () => {
    const result = revealGap(FILE, context(), 1, 1, "batch", 10);
    expect(result).toEqual({
      reveal: { top: 10, bottom: 0 },
      hidden: 23,
      landing: { oldLine: 23, newLine: 23 },
    });
  });

  it("reveals a batch above the hunk below when arriving with ↑", () => {
    const result = revealGap(FILE, context(), 1, -1, "batch", 10);
    expect(result?.reveal).toEqual({ top: 0, bottom: 10 });
    expect(result?.landing.newLine).toBe(37);
  });

  it("reveals a section at the other end with ⌥↵", () => {
    const result = revealGap(FILE, context(), 1, 1, "other", 10);
    expect(result?.reveal).toEqual({ top: 0, bottom: 10 });
    expect(result?.hidden).toBe(23);
  });

  it("never reveals more than one section of a long gap", () => {
    const result = revealGap(FILE, context(), 1, 1, "batch");
    expect(result).toMatchObject({ reveal: { top: 20, bottom: 0 }, hidden: 13 });
  });

  it("closes the gap after enough batches and then stops", () => {
    let ctx = context();
    let result = revealGap(FILE, ctx, 2, 1, "batch", 5);
    expect(result).toMatchObject({ reveal: { top: 5 }, hidden: 2 });
    ctx = context({ 2: result!.reveal });
    result = revealGap(FILE, ctx, 2, 1, "batch", 5);
    expect(result).toMatchObject({ reveal: { top: 7 }, hidden: 0, landing: { newLine: 59 } });
    expect(revealGap(FILE, context({ 2: result!.reveal }), 2, 1, "batch", 5)).toBeNull();
  });

  it("does nothing before the file is loaded", () => {
    expect(revealGap(FILE, context({}, null), 1, 1, "batch")).toBeNull();
  });
});

describe("growGap", () => {
  it("reveals one section at the clicked end", () => {
    expect(growGap(FILE, context(), 1, ["top"], 20)).toEqual({ top: 20, bottom: 0 });
    expect(growGap(FILE, context({ 1: { top: 30, bottom: 0 } }), 1, ["top"], 20)).toEqual({
      top: 33,
      bottom: 0,
    });
    expect(growGap(FILE, context({ 1: { top: 33, bottom: 0 } }), 1, ["top"], 1)).toBeNull();
  });

  it("splits one section between both ends, never the whole gap", () => {
    expect(growGap(FILE, context(), 1, ["top", "bottom"], 21)).toEqual({ top: 11, bottom: 10 });
    // Above the first hunk only the bottom end exists.
    expect(growGap(FILE, context(), 0, ["top", "bottom"], 4)).toEqual({ top: 0, bottom: 4 });
  });
});
