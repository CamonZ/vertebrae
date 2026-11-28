/**
 * Invariants of the review model behind the diff markers, the Outdated
 * pills and the Review rail, checked against expectations computed straight
 * from the generated threads and placements, never through the model.
 */
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type {
  GithubReviewThread,
  GithubThreadPlacement,
  GithubThreadPosition,
} from "../../../../bindings";
import { at, reviewThread } from "./fixture";
import {
  buildReviewModel,
  driftExplanation,
  hunksShow,
  lineLabel,
  lineList,
  markerKey,
  sideName,
  stepThread,
  type PlacedThread,
} from "./model";

const PATHS = ["src/lib.rs", "src/a.rs", "README.md", "Src/lib.rs"];

const lineGen = gs.integers({ minValue: 1, maxValue: 40 });

const placementGen: gs.Generator<GithubThreadPlacement> =
  gs.oneOf<GithubThreadPlacement>(
    gs
      .tuples(lineGen, gs.integers({ minValue: 0, maxValue: 3 }), lineGen)
      .map(([line, span, publishedLine]) => ({
        kind: "anchored",
        startLine: Math.max(1, line - span),
        line,
        publishedLine,
      })),
    gs
      .tuples(
        lineGen,
        gs.integers({ minValue: 0, maxValue: 3 }),
        gs.integers({ minValue: 0, maxValue: 15 })
      )
      .map(([line, span, mask]) => {
        const startLine = Math.max(1, line - span);
        return {
          kind: "edited",
          startLine,
          line,
          published: [],
          // Any subset of the range, none included (an insertion inside).
          editedLines: Array.from(
            { length: line - startLine + 1 },
            (_, index) => startLine + index
          ).filter((_, index) => (mask >> index) & 1),
          publishedCommit: "1".repeat(40),
        };
      }),
    gs
      .tuples(lineGen, gs.integers({ minValue: 0, maxValue: 3 }))
      .map(([line, span]) => ({
        kind: "unverified",
        startLine: Math.max(1, line - span),
        line,
      })),
    gs.optional(lineGen).map((line) => ({
      kind: "outdated",
      originalStartLine: line,
      originalLine: line,
      original: [],
      originalCommit: null,
    })),
    gs.sampledFrom<GithubThreadPlacement>([
      { kind: "file_level" },
      { kind: "not_shown" },
      { kind: "unplaceable", reason: "invalid_anchor" },
      { kind: "unplaceable", reason: "unreadable" },
    ])
  );

/** Threads with distinct ids; each placed, or not placed yet. */
const reviewGen = gs
  .arrays(
    gs.tuples(
      gs.sampledFrom(PATHS),
      gs.sampledFrom(["LEFT", "RIGHT"] as const),
      gs.booleans(),
      gs.optional(placementGen)
    ),
    { maxSize: 12 }
  )
  .map((rows) => {
    const threads: GithubReviewThread[] = [];
    const positions: GithubThreadPosition[] = [];
    rows.forEach(([path, side, resolved, placement], index) => {
      const id = `t${index}`;
      threads.push(reviewThread(id, { path, side, resolved }));
      if (placement) positions.push(at(id, placement));
    });
    return { threads, positions };
  });

const shownGen = gs
  .arrays(gs.tuples(gs.sampledFrom(PATHS), lineGen), { maxSize: 20 })
  .map((pairs) => new Set(pairs.map(([path, line]) => `${path}:${line}`)));

test("every placed thread lands exactly once, in the rail and where it is drawn", () =>
  hegel.test((tc) => {
    const { threads, positions } = tc.draw(reviewGen);
    const shownLines = tc.draw(shownGen);
    const shown = (path: string, _side: string, line: number) =>
      shownLines.has(`${path}:${line}`);
    const model = buildReviewModel(7, threads, positions, false, shown);
    const placements = new Map(positions.map((p) => [p.threadId, p.placement]));

    // Placed threads only, each once in byThread and once in the rail.
    const placedIds = threads
      .filter((t) => placements.has(t.id))
      .map((t) => t.id);
    expect([...model.byThread.keys()].sort()).toEqual([...placedIds].sort());
    const railIds = model.files.flatMap((file) =>
      file.threads.map(({ thread }) => thread.id)
    );
    expect(railIds.sort()).toEqual([...placedIds].sort());

    // The rail: files in path order, threads in line order, each in its file.
    const paths = model.files.map((file) => file.path);
    expect(paths).toEqual([...new Set(paths)]);
    for (let i = 1; i < paths.length; i++)
      expect(paths[i - 1].localeCompare(paths[i])).toBeLessThan(0);
    const lineOf = (placed: PlacedThread) =>
      placed.kind === "line"
        ? placed.line
        : placed.kind === "outdated"
          ? (placed.originalLine ?? 0)
          : 0;
    for (const file of model.files) {
      for (const { thread } of file.threads)
        expect(thread.anchor.path).toBe(file.path);
      for (let i = 1; i < file.threads.length; i++)
        expect(lineOf(file.threads[i - 1])).toBeLessThanOrEqual(
          lineOf(file.threads[i])
        );
    }

    // Markers: exactly the line threads the diff shows, one per line and side.
    const expectedMarked = threads.filter((thread) => {
      const placement = placements.get(thread.id);
      return (
        placement &&
        (placement.kind === "anchored" ||
          placement.kind === "edited" ||
          placement.kind === "unverified") &&
        shownLines.has(`${thread.anchor.path}:${placement.line}`)
      );
    });
    const marked = [...model.markerByKey.values()].flatMap((marker) =>
      marker.threads.map(({ thread }) => thread.id)
    );
    expect(marked.sort()).toEqual(expectedMarked.map((t) => t.id).sort());
    for (const marker of model.markerByKey.values()) {
      expect(marker.key).toBe(markerKey(marker.path, marker.side, marker.line));
      for (const placed of marker.threads) {
        expect(placed.inDiff).toBe(true);
        expect(placed.side).toBe(sideName(placed.thread.anchor.side));
        expect(placed.line).toBe(marker.line);
        expect(placed.thread.anchor.path).toBe(marker.path);
      }
    }
    const byPath = [...model.markersByPath.values()].flat();
    expect(byPath).toHaveLength(model.markerByKey.size);

    // Outdated: exactly the outdated placements, under their file.
    const expectedOutdated = threads
      .filter((t) => placements.get(t.id)?.kind === "outdated")
      .map((t) => t.id);
    const listed = [...model.outdatedByPath.entries()].flatMap(([path, list]) =>
      list.map(({ thread }) => {
        expect(thread.anchor.path).toBe(path);
        return thread.id;
      })
    );
    expect(listed.sort()).toEqual(expectedOutdated.sort());

    expect(model.openCount).toBe(threads.filter((t) => !t.resolved).length);
  }));

test("a line label spans the placement's own start and end lines", () =>
  hegel.test((tc) => {
    const { threads, positions } = tc.draw(reviewGen);
    const model = buildReviewModel(7, threads, positions, false);
    for (const position of positions) {
      const placed = model.byThread.get(position.threadId)!;
      const placement = position.placement;
      if (
        placement.kind === "anchored" ||
        placement.kind === "edited" ||
        placement.kind === "unverified"
      )
        expect(lineLabel(placed)).toBe(
          placement.startLine < placement.line
            ? `lines ${placement.startLine}–${placement.line}`
            : `line ${placement.line}`
        );
    }
  }));

test("hunksShow is membership in some hunk's span on the asked side", () =>
  hegel.test((tc) => {
    const hunks = tc.draw(
      gs.arrays(
        gs
          .tuples(
            lineGen,
            gs.integers({ minValue: 0, maxValue: 8 }),
            lineGen,
            gs.integers({ minValue: 0, maxValue: 8 })
          )
          .map(
            ([additionStart, additionCount, deletionStart, deletionCount]) => ({
              additionStart,
              additionCount,
              deletionStart,
              deletionCount,
            })
          ),
        { maxSize: 4 }
      )
    );
    const side = tc.draw(gs.sampledFrom(["additions", "deletions"] as const));
    const line = tc.draw(gs.integers({ minValue: 0, maxValue: 60 }));
    const rows = new Set(
      hunks.flatMap((hunk) => {
        const start =
          side === "additions" ? hunk.additionStart : hunk.deletionStart;
        const count =
          side === "additions" ? hunk.additionCount : hunk.deletionCount;
        return Array.from({ length: count }, (_, offset) => start + offset);
      })
    );
    expect(hunksShow(hunks, side, line)).toBe(rows.has(line));
  }));

/*
 * `[` and `]` (stepThread). Expectations come from the generated threads'
 * (path, line) keys, never from the model's own ordering: stepping visits
 * every thread once in key order and stops at either end; from a line it
 * lands on the nearest thread strictly past it, with none in between.
 */
const keyOf = (placed: PlacedThread): [string, number] => [
  placed.thread.anchor.path,
  placed.kind === "line"
    ? placed.line
    : placed.kind === "outdated"
      ? (placed.originalLine ?? 0)
      : 0,
];
const compareKeys = ([pa, la]: [string, number], [pb, lb]: [string, number]) =>
  pa.localeCompare(pb) || la - lb;

test("[ and ] visit every thread once, in path and line order, without wrapping", () =>
  hegel.test((tc) => {
    const { threads, positions } = tc.draw(reviewGen);
    const model = buildReviewModel(7, threads, positions, false);
    const placed = [...model.byThread.values()];

    for (const direction of [1, -1] as const) {
      const visited: PlacedThread[] = [];
      let at = stepThread(model, null, direction);
      while (at) {
        visited.push(at);
        at = stepThread(model, { kind: "thread", id: at.thread.id }, direction);
      }
      expect(visited.map(({ thread }) => thread.id).sort()).toEqual(
        placed.map(({ thread }) => thread.id).sort()
      );
      for (let i = 1; i < visited.length; i++)
        expect(
          direction * compareKeys(keyOf(visited[i - 1]), keyOf(visited[i]))
        ).toBeLessThanOrEqual(0);
    }
    // A thread the PR no longer has steps like nowhere.
    expect(stepThread(model, { kind: "thread", id: "gone" }, 1)).toBe(
      stepThread(model, null, 1)
    );
  }));

test("from a line, [ and ] land on the nearest thread strictly past it", () =>
  hegel.test((tc) => {
    const { threads, positions } = tc.draw(reviewGen);
    const model = buildReviewModel(7, threads, positions, false);
    const placed = [...model.byThread.values()];
    const from: [string, number] = [
      tc.draw(gs.sampledFrom(PATHS)),
      tc.draw(gs.integers({ minValue: 0, maxValue: 42 })),
    ];
    const direction = tc.draw(gs.sampledFrom([1, -1] as const));
    const past = (p: PlacedThread) =>
      direction * compareKeys(keyOf(p), from) > 0;

    const next = stepThread(
      model,
      { kind: "line", path: from[0], line: from[1] },
      direction
    );
    if (!placed.some(past)) {
      expect(next).toBeNull();
      return;
    }
    expect(next).not.toBeNull();
    expect(past(next!)).toBe(true);
    for (const other of placed.filter(past))
      expect(
        direction * compareKeys(keyOf(other), keyOf(next!))
      ).toBeGreaterThanOrEqual(0);
  }));

/** The line numbers a `lineList` phrase names, read back from its text. */
function namedLines(text: string): number[] {
  return text
    .replace(/^lines? /, "")
    .split(/, | and /)
    .flatMap((part) => {
      const [from, to = from] = part.split("–").map(Number);
      return Array.from({ length: to - from + 1 }, (_, index) => from + index);
    });
}

test("lineList names exactly the given lines, runs collapsed", () =>
  hegel.test((tc) => {
    const lines = [
      ...new Set(tc.draw(gs.arrays(lineGen, { maxSize: 12 }))),
    ].sort((a, b) => a - b);
    const text = lineList(lines);
    if (lines.length === 0) return expect(text).toBeNull();
    expect(namedLines(text!)).toEqual(lines);
    expect(text!.startsWith(lines.length === 1 ? "line " : "lines ")).toBe(
      true
    );
    // Runs are collapsed: each part starts past a gap after the previous.
    const parts = text!
      .replace(/^lines? /, "")
      .split(/, | and /)
      .map((part) => part.split("–").map(Number));
    for (let index = 1; index < parts.length; index++)
      expect(parts[index][0]).toBeGreaterThan(parts[index - 1].at(-1)! + 1);
  }));

test("an edited range's note names the lines the edit changed", () =>
  hegel.test((tc) => {
    const { threads, positions } = tc.draw(reviewGen);
    const model = buildReviewModel(7, threads, positions, false);
    for (const position of positions) {
      const placement = position.placement;
      if (placement.kind !== "edited") continue;
      const placed = model.byThread.get(position.threadId)!;
      if (placed.kind !== "line") continue;
      expect(placed.drift).toEqual({
        kind: "edited",
        lines: placement.editedLines,
        commit: placement.publishedCommit,
      });
      const note = driftExplanation(placed)!;
      if (placement.startLine >= placement.line) continue;
      const named = lineList(placement.editedLines);
      if (named) expect(note.toLowerCase()).toContain(named);
      else expect(note).toMatch(/lines (added|inside)/);
    }
  }));
