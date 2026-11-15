import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { parseDiffFromFile } from "@pierre/diffs";
import type { WorktreeChange } from "../../../bindings";
import { routeSource } from "./sourceRoute";

/**
 * A generated edit with its exact line correspondence. Every line is unique,
 * so the longest common subsequence is the kept lines and the diff engine
 * must agree with this alignment.
 */
interface Edit {
  before: string[];
  after: string[];
  /** One-based new line of each kept old line; `null` when deleted/replaced. */
  oldToNew: (number | null)[];
  /** One-based old line of each kept new line; `null` when inserted. */
  newToOld: (number | null)[];
}

// Per old line: 0–2 keep, 3 delete, 4 replace.
const OP = gs.integers({ minValue: 0, maxValue: 4 });
// Lines inserted before an old line (or at the end): mostly none.
const INSERTS = gs
  .integers({ minValue: 0, maxValue: 6 })
  .map((count) => (count > 3 ? 0 : count));

function drawEdit(tc: hegel.TestCase): Edit {
  const length = tc.draw(gs.integers({ minValue: 1, maxValue: 30 }));
  const before = Array.from({ length }, (_, index) => `old ${index + 1}`);
  const after: string[] = [];
  const oldToNew: (number | null)[] = [];
  const newToOld: (number | null)[] = [];
  let fresh = 0;
  const insert = (count: number) => {
    for (let index = 0; index < count; index++) {
      after.push(`new ${++fresh}`);
      newToOld.push(null);
    }
  };
  for (let line = 1; line <= length; line++) {
    insert(tc.draw(INSERTS));
    const op = tc.draw(OP);
    if (op <= 2) {
      after.push(before[line - 1]);
      newToOld.push(line);
      oldToNew.push(after.length);
    } else {
      oldToNew.push(null);
      if (op === 4) insert(1);
    }
  }
  insert(tc.draw(INSERTS));
  return { before, after, oldToNew, newToOld };
}

/** `line..endLine`, one-based and within `count` lines. */
function drawRange(tc: hegel.TestCase, count: number) {
  const line = tc.draw(gs.integers({ minValue: 1, maxValue: count }));
  const endLine = tc.draw(gs.integers({ minValue: line, maxValue: count }));
  return { line, endLine };
}

const span = (line: number, endLine: number) =>
  Array.from({ length: endLine - line + 1 }, (_, index) => line + index);

/**
 * Whether a range and its neighbours are unchanged and contiguous on both
 * sides, so it is clear of every change, including pure insertions and
 * deletions at its edges.
 */
function isolated(
  map: (number | null)[],
  line: number,
  endLine: number,
  otherLength: number
) {
  const from = Math.max(1, line - 1);
  const to = Math.min(map.length, endLine + 1);
  const mapped = span(from, to).map((index) => map[index - 1]);
  if (mapped.some((value) => value == null)) return false;
  const values = mapped as number[];
  if (
    values.some((value, index) => index > 0 && value !== values[index - 1] + 1)
  )
    return false;
  // At a file edge nothing may be inserted or deleted beyond the range.
  if (line === 1 && values[0] !== 1) return false;
  if (endLine === map.length && values[values.length - 1] !== otherLength)
    return false;
  return true;
}

test("generated references route to the diff exactly when their lines changed", () =>
  hegel.test(
    (tc) => {
      const edit = drawEdit(tc);
      const { before, after } = edit;
      tc.assume(after.length > 0);
      const changed = before.join() !== after.join();
      const renamed = changed && tc.draw(gs.booleans());
      const path = renamed ? "next.ts" : "f.ts";
      const side = tc.draw(gs.sampledFrom(["old", "new"] as const));
      const { line, endLine } = drawRange(
        tc,
        side === "old" ? before.length : after.length
      );
      const target = {
        path: side === "old" && renamed ? "prev.ts" : path,
        line,
        endLine,
        side,
        nonce: 7,
      };

      const text = (lines: string[]) => lines.join("\n") + "\n";
      const files: WorktreeChange[] = changed
        ? [
            {
              path,
              old_path: renamed ? "prev.ts" : null,
              status: renamed ? "renamed" : "modified",
              marker: null,
              totals: { additions: 0, deletions: 0, binary_files: 0 },
              patch: "",
            },
          ]
        : [];
      const parsed = changed
        ? [
            {
              files: [
                parseDiffFromFile(
                  { name: renamed ? "prev.ts" : path, contents: text(before) },
                  { name: path, contents: text(after) }
                ),
              ],
            },
          ]
        : [];
      const route = routeSource(target, files, parsed);

      const map = side === "old" ? edit.oldToNew : edit.newToOld;
      const rangeChanged = span(line, endLine).some(
        (index) => map[index - 1] == null
      );
      const clear = isolated(
        map,
        line,
        endLine,
        side === "old" ? after.length : before.length
      );

      if (!changed) {
        // A file without changes always opens in full at the same lines.
        expect(route).toEqual({
          view: "file",
          path: target.path,
          reveal: { path: target.path, line, endLine, nonce: 7 },
        });
        return;
      }
      if (rangeChanged) expect(route.view).toBe("diff");
      if (clear) expect(route.view).toBe("file");

      if (route.view === "diff") {
        expect(route.target).toEqual({ ...target, path });
        return;
      }
      // The full file is the working copy: every revealed line is the line
      // the reference named, renumbered for old-side references.
      expect(route.path).toBe(path);
      expect(route.reveal).not.toBeNull();
      const reveal = route.reveal!;
      expect(reveal.nonce).toBe(7);
      expect(reveal.endLine - reveal.line).toBe(endLine - line);
      const shown = after.slice(reveal.line - 1, reveal.endLine);
      const named = (side === "old" ? before : after).slice(line - 1, endLine);
      expect(shown).toEqual(named);
    },
    { testCases: 500 }
  ));
