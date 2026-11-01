import { describe, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import {
  findRow,
  parsePatch,
  resolveSelection,
  rowLine,
  spanRows,
  type FilePatch,
  type HunkRow,
  type RowLocation,
} from "./diffLineMapper";
import { createDiffComment } from "./diffComments";
import { drawScenario, drawSelectionPoint } from "./diffScenario.test.helpers";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

/** A file from a random scenario: one tool call's patch or All Changes. */
function drawFile(tc: TestCase): FilePatch | undefined {
  const scenario = drawScenario(tc, tc.draw(gs.booleans()));
  const patches = [
    ...scenario.calls.map((call) => call.patch),
    scenario.worktreePatch,
  ];
  const patch =
    patches[
      tc.draw(gs.integers({ minValue: 0, maxValue: patches.length - 1 }))
    ];
  return parsePatch(patch)[0];
}

function before(a: RowLocation, b: RowLocation): boolean {
  return (a.hunkIndex - b.hunkIndex || a.rowIndex - b.rowIndex) < 0;
}

describe("multi-line selections", () => {
  test("a reversed selection resolves to the same span", () =>
    hegel.test((tc) => {
      const file = drawFile(tc);
      if (!file) return;
      const a = drawSelectionPoint(tc, file);
      const b = drawSelectionPoint(tc, file);
      if (!a || !b) return;
      check(
        JSON.stringify(resolveSelection(file, a.point, b.point)) ===
          JSON.stringify(resolveSelection(file, b.point, a.point)),
        "selection order changed the span"
      );
    }));

  test("a span ends on the later row and covers exactly the shown rows up to it", () =>
    hegel.test((tc) => {
      const file = drawFile(tc);
      if (!file) return;
      const a = drawSelectionPoint(tc, file);
      const b = drawSelectionPoint(tc, file);
      if (!a || !b) return;
      const span = resolveSelection(file, a.point, b.point);
      check(span !== null, "two shown endpoints must resolve");
      const [first, last] = before(b.location, a.location)
        ? [b.location, a.location]
        : [a.location, b.location];

      const side = last.row.kind === "del" ? "old" : "new";
      check(span!.side === side, "side does not follow the later row");
      check(span!.startLine <= span!.endLine, "span is reversed");
      check(
        findRow(file, side, span!.endLine)?.row === last.row,
        "span does not end on the later row"
      );

      // The rows between the endpoints (clamped to the later row's hunk)
      // that have a number on the chosen side, in patch order.
      const from = first.hunkIndex === last.hunkIndex ? first.rowIndex : 0;
      const expected: HunkRow[] = last.hunk.rows
        .slice(from, last.rowIndex + 1)
        .filter((row) => rowLine(row, side) !== null);
      const covered = spanRows(file, span!);
      check(covered !== null, "span covers a line the diff does not show");
      check(
        covered!.length === expected.length &&
          covered!.every((row, i) => row === expected[i]),
        "span rows differ from the selected rows"
      );
    }));

  test("every resolved span can be commented on", () =>
    hegel.test((tc) => {
      const file = drawFile(tc);
      if (!file) return;
      const a = drawSelectionPoint(tc, file);
      const b = drawSelectionPoint(tc, file);
      if (!a || !b) return;
      const span = resolveSelection(file, a.point, b.point)!;
      const comment = createDiffComment({
        id: "c",
        body: "b",
        home: { kind: "worktree", wholeBranch: false },
        file,
        span,
      });
      check(comment !== null, "a resolved span must be commentable");
      check(
        comment!.startLine === span.startLine &&
          comment!.endLine === span.endLine &&
          comment!.side === span.side,
        "comment does not keep the span"
      );
    }));
});
