import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import { filePatch } from "./diffPatchBuilder.test.helpers";
import type { FilePatch, RowLocation, SelectionPoint } from "./diffLineMapper";

export interface ScenarioLine {
  /** Identity: unique across the whole scenario, even when text repeats. */
  id: number;
  text: string;
}

export interface ScenarioCall {
  patch: string;
  before: ScenarioLine[];
  after: ScenarioLine[];
  /** Path before and after the call. */
  oldPath: string;
  path: string;
}

export interface Scenario {
  baseline: ScenarioLine[];
  baselinePath: string;
  calls: ScenarioCall[];
  final: ScenarioLine[];
  finalPath: string;
  /** All Changes: baseline -> working tree for the file. */
  worktreePatch: string;
}

const REPEATED_POOL = ["", "}", "{", "return;", "x"];

/**
 * A baseline and 1..5 tool calls of random inserts and deletes (no moves),
 * some renaming the file. `unique` gives every line distinct text, so the
 * line identity is the ground truth; otherwise lines repeat blanks and braces.
 */
export function drawScenario(tc: TestCase, unique: boolean): Scenario {
  let nextId = 0;
  const fresh = (): ScenarioLine => {
    const id = nextId++;
    return {
      id,
      text: unique ? `line ${id}` : tc.draw(gs.sampledFrom(REPEATED_POOL)),
    };
  };
  const baselineSize = tc.draw(gs.integers({ minValue: 0, maxValue: 25 }));
  const baseline = Array.from({ length: baselineSize }, fresh);
  let renames = 0;
  const baselinePath = "f0.txt";
  let path = baselinePath;
  let state = baseline;
  const calls: ScenarioCall[] = [];
  const callCount = tc.draw(gs.integers({ minValue: 1, maxValue: 5 }));
  for (let c = 0; c < callCount; c++) {
    const before = state;
    let next = [...state];
    const ops = tc.draw(gs.integers({ minValue: 0, maxValue: 4 }));
    for (let o = 0; o < ops; o++) {
      const insert = tc.draw(gs.booleans());
      if (insert || next.length === 0) {
        const at = tc.draw(gs.integers({ minValue: 0, maxValue: next.length }));
        const count = tc.draw(gs.integers({ minValue: 1, maxValue: 3 }));
        next.splice(at, 0, ...Array.from({ length: count }, fresh));
      } else {
        const at = tc.draw(
          gs.integers({ minValue: 0, maxValue: next.length - 1 })
        );
        const count = tc.draw(gs.integers({ minValue: 1, maxValue: 2 }));
        next.splice(at, count);
      }
    }
    next = [...next];
    const oldPath = path;
    if (tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0) {
      path = `f${++renames}.txt`;
    }
    calls.push({
      patch: filePatch({
        oldPath,
        path,
        before: before.map((l) => l.text),
        after: next.map((l) => l.text),
      }),
      before,
      after: next,
      oldPath,
      path,
    });
    state = next;
  }
  return {
    baseline,
    baselinePath,
    calls,
    final: state,
    finalPath: path,
    worktreePatch: filePatch({
      oldPath: baselinePath,
      path,
      before: baseline.map((l) => l.text),
      after: state.map((l) => l.text),
    }),
  };
}

/** A gutter selection endpoint on a shown row, with the row it points at. */
export interface DrawnPoint {
  point: SelectionPoint;
  location: RowLocation;
}

/**
 * A selection endpoint on a random row of `file`, as Pierre reports it: a
 * deleted row on the deletions side, an added row on the additions side, a
 * context row on either. Null when the file has no rows.
 */
export function drawSelectionPoint(
  tc: TestCase,
  file: FilePatch
): DrawnPoint | null {
  const locations: RowLocation[] = file.hunks.flatMap((hunk, hunkIndex) =>
    hunk.rows.map((row, rowIndex) => ({ hunk, hunkIndex, rowIndex, row }))
  );
  if (locations.length === 0) return null;
  const location =
    locations[
      tc.draw(gs.integers({ minValue: 0, maxValue: locations.length - 1 }))
    ];
  const { row } = location;
  const deletions =
    row.kind === "del" || (row.kind === "context" && tc.draw(gs.booleans()));
  return {
    location,
    point: deletions
      ? { side: "deletions", line: row.oldLine! }
      : { side: "additions", line: row.newLine! },
  };
}
