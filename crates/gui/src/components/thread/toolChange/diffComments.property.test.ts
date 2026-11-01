import { describe, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { TestCase } from "@hegeldev/hegel";
import {
  computePlacements,
  createDiffComment,
  parseWorktreeSnapshot,
  reconcileWorktreeComments,
  type Placement,
  type WorktreeSnapshot,
} from "./diffComments";
import {
  findRow,
  parsePatch,
  resolveSelection,
  type FilePatch,
  type HunkRow,
  type ToolPatch,
} from "./diffLineMapper";
import { drawScenario, drawSelectionPoint } from "./diffScenario.test.helpers";
import type { DiffCommentHome } from "../../ChatWindow/assistantTextComments";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function textAt(
  files: readonly FilePatch[],
  placement: Placement
): string | null {
  const file = files.find((f) => (f.newPath ?? f.oldPath) === placement.path);
  return file
    ? (findRow(file, placement.side, placement.startLine)?.row.text ?? null)
    : null;
}

describe("diff comment placements", () => {
  test("a comment is always drawn on its home patch, and projections keep the line text", () =>
    hegel.test((tc) => {
      const scenario = drawScenario(tc, tc.draw(gs.booleans()));
      const chain: ToolPatch[] = scenario.calls.map((call, i) => ({
        id: `t${i}`,
        files: parsePatch(call.patch),
      }));
      const worktree = parseWorktreeSnapshot(false, [scenario.worktreePatch]);

      const surfaces: Array<{
        home: DiffCommentHome;
        files: readonly FilePatch[];
      }> = [
        ...chain.map((patch) => ({
          home: { kind: "tool_call", toolUseId: patch.id } as DiffCommentHome,
          files: patch.files,
        })),
        {
          home: { kind: "worktree", wholeBranch: false },
          files: worktree.files,
        },
      ];
      for (const { home, files } of surfaces) {
        const file = files[0];
        if (!file) continue;
        for (const hunk of file.hunks) {
          for (const row of hunk.rows as HunkRow[]) {
            const side = row.kind === "del" ? "old" : "new";
            const line = side === "old" ? row.oldLine! : row.newLine!;
            const comment = createDiffComment({
              id: "c",
              body: "b",
              home,
              file,
              span: { side, startLine: line, endLine: line },
            });
            check(comment !== null, "a shown row must be commentable");
            const placements = computePlacements([comment!], chain, worktree);
            const homes = placements.filter((p) => p.home);
            check(homes.length === 1, "exactly one home placement");
            check(
              homes[0].startLine === line && homes[0].endLine === line,
              "home placement moved"
            );
            check(
              homes[0].surface.kind === home.kind,
              "home placement on wrong surface"
            );
            for (const other of placements.filter((p) => !p.home)) {
              check(
                other.surface.kind !== home.kind,
                "projection stayed on the home surface kind"
              );
              const target =
                other.surface.kind === "worktree"
                  ? worktree.files
                  : (chain.find(
                      (p) =>
                        other.surface.kind === "tool_call" &&
                        p.id === other.surface.toolUseId
                    )?.files ?? []);
              check(
                textAt(target, other) === row.text,
                "projected line text differs"
              );
            }
          }
        }
      }
    }));

  test("an unchanged All Changes patch never marks a comment outdated", () =>
    hegel.test((tc) => {
      const scenario = drawScenario(tc, true);
      const worktree = parseWorktreeSnapshot(false, [scenario.worktreePatch]);
      const file = worktree.files[0];
      if (!file) return;
      const comments = file.hunks.flatMap((hunk) =>
        hunk.rows.map((row) => {
          const side = row.kind === "del" ? "old" : "new";
          const line = side === "old" ? row.oldLine! : row.newLine!;
          return createDiffComment({
            id: `${side}${line}`,
            body: "b",
            home: { kind: "worktree", wholeBranch: false },
            file,
            span: { side, startLine: line, endLine: line },
          })!;
        })
      );
      check(
        reconcileWorktreeComments(comments, worktree) === comments,
        "reconciliation changed unchanged comments"
      );
    }));
});

/** The comment's surfaces: each tool call's patch, then All Changes. */
function surfacesOf(chain: readonly ToolPatch[], worktree: WorktreeSnapshot) {
  return [
    ...chain.map((patch) => ({
      home: { kind: "tool_call", toolUseId: patch.id } as DiffCommentHome,
      files: patch.files,
    })),
    {
      home: { kind: "worktree", wholeBranch: false } as DiffCommentHome,
      files: worktree.files,
    },
  ];
}

/** A multi-line comment made by selecting two random rows of a surface. */
function drawMultiLineComment(
  tc: TestCase,
  chain: readonly ToolPatch[],
  worktree: WorktreeSnapshot
) {
  const surfaces = surfacesOf(chain, worktree);
  const { home, files } =
    surfaces[
      tc.draw(gs.integers({ minValue: 0, maxValue: surfaces.length - 1 }))
    ];
  const file = files[0];
  if (!file) return null;
  const a = drawSelectionPoint(tc, file);
  const b = drawSelectionPoint(tc, file);
  if (!a || !b) return null;
  const span = resolveSelection(file, a.point, b.point)!;
  return createDiffComment({ id: "c", body: "b", home, file, span })!;
}

function surfaceKey(placement: Placement): string {
  return placement.surface.kind === "worktree"
    ? "worktree"
    : `tool:${placement.surface.toolUseId}`;
}

/** Each line a projection covers, as surface|path|side|line. */
function projectedLines(placements: readonly Placement[]): Set<string> {
  const lines = new Set<string>();
  for (const p of placements.filter((p) => !p.home)) {
    for (let line = p.startLine; line <= p.endLine; line++) {
      lines.add(`${surfaceKey(p)}|${p.path}|${p.side}|${line}`);
    }
  }
  return lines;
}

describe("multi-line diff comment placements", () => {
  test("a multi-line comment is drawn once on its home patch over its whole span", () =>
    hegel.test((tc) => {
      const scenario = drawScenario(tc, tc.draw(gs.booleans()));
      const chain = scenario.calls.map((call, i) => ({
        id: `t${i}`,
        files: parsePatch(call.patch),
      }));
      const worktree = parseWorktreeSnapshot(false, [scenario.worktreePatch]);
      const comment = drawMultiLineComment(tc, chain, worktree);
      if (!comment) return;
      const homes = computePlacements([comment], chain, worktree).filter(
        (p) => p.home
      );
      check(homes.length === 1, "exactly one home placement");
      check(
        homes[0].startLine === comment.startLine &&
          homes[0].endLine === comment.endLine &&
          homes[0].side === comment.side,
        "home placement does not cover the span"
      );
      check(
        homes[0].surface.kind === comment.home.kind,
        "home placement on wrong surface"
      );
    }));

  test("a multi-line comment projects exactly the lines its single lines project, in maximal runs", () =>
    hegel.test((tc) => {
      const scenario = drawScenario(tc, tc.draw(gs.booleans()));
      const chain = scenario.calls.map((call, i) => ({
        id: `t${i}`,
        files: parsePatch(call.patch),
      }));
      const worktree = parseWorktreeSnapshot(false, [scenario.worktreePatch]);
      const comment = drawMultiLineComment(tc, chain, worktree);
      if (!comment) return;
      const placements = computePlacements([comment], chain, worktree);

      const singles = [];
      for (let line = comment.startLine; line <= comment.endLine; line++) {
        singles.push({
          ...comment,
          id: `c${line}`,
          startLine: line,
          endLine: line,
        });
      }
      const expected = projectedLines(
        computePlacements(singles, chain, worktree)
      );
      const actual = projectedLines(placements);
      check(
        actual.size === expected.size &&
          [...actual].every((line) => expected.has(line)),
        "projection covers different lines than the single lines do"
      );

      const projections = placements.filter((p) => !p.home);
      for (const p of projections) {
        check(p.startLine <= p.endLine, "projection is reversed");
        check(p.side === comment.side, "projection changed side");
        check(
          p.surface.kind !== comment.home.kind,
          "projection stayed on the home surface kind"
        );
      }
      // Runs on one surface and file never overlap or touch: touching lines
      // would have been one range, so a gap between ranges is a real gap.
      for (const p of projections) {
        for (const q of projections) {
          if (p === q || surfaceKey(p) !== surfaceKey(q) || p.path !== q.path) {
            continue;
          }
          check(
            p.endLine + 1 < q.startLine || q.endLine + 1 < p.startLine,
            "projection ranges overlap or touch"
          );
        }
      }
    }));

  test("an unchanged All Changes patch never marks a multi-line comment outdated", () =>
    hegel.test((tc) => {
      const scenario = drawScenario(tc, tc.draw(gs.booleans()));
      const worktree = parseWorktreeSnapshot(false, [scenario.worktreePatch]);
      const file = worktree.files[0];
      if (!file) return;
      const a = drawSelectionPoint(tc, file);
      const b = drawSelectionPoint(tc, file);
      if (!a || !b) return;
      const comment = createDiffComment({
        id: "c",
        body: "b",
        home: { kind: "worktree", wholeBranch: false },
        file,
        span: resolveSelection(file, a.point, b.point)!,
      })!;
      const comments = [comment];
      check(
        reconcileWorktreeComments(comments, worktree) === comments,
        "reconciliation changed an unchanged multi-line comment"
      );
    }));
});
