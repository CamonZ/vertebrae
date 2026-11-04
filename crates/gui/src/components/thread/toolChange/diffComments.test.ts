import { describe, expect, it } from "vitest";
import {
  buildToolChain,
  computePlacements,
  createDiffComment,
  parseWorktreeSnapshot,
  reconcileWorktreeComments,
  type WorktreeSnapshot,
} from "./diffComments";
import { canonicalPath, parsePatch, type ToolPatch } from "./diffLineMapper";
import { filePatch, numbered } from "./diffPatchBuilder.test.helpers";
import {
  formatTextCommentsForReply,
  type PendingDiffComment,
} from "../../ChatWindow/assistantTextComments";

const BASE = numbered("l", 20);
const withX = [...BASE.slice(0, 5), "X", ...BASE.slice(5)];
const withoutL12 = withX.filter((l) => l !== "l12");

function chainOf(...patches: string[]): ToolPatch[] {
  return patches.map((patch, i) => ({
    id: `tool-${i + 1}`,
    files: parsePatch(patch),
  }));
}

const chain = chainOf(
  filePatch({ path: "f", before: BASE, after: withX }),
  filePatch({ path: "f", before: withX, after: withoutL12 })
);
const worktree = parseWorktreeSnapshot(false, [
  filePatch({ path: "f", before: BASE, after: withoutL12 }),
]);

function diffComment(
  overrides: Partial<PendingDiffComment> & Pick<PendingDiffComment, "home">
): PendingDiffComment {
  return {
    kind: "diff",
    id: "c1",
    body: "note",
    path: "f",
    side: "new",
    startLine: 6,
    endLine: 6,
    hunk: "",
    outdated: false,
    ...overrides,
  };
}

describe("createDiffComment", () => {
  it("captures the hunk through the last commented row", () => {
    const file = chain[0].files[0];
    const comment = createDiffComment({
      id: "c",
      body: "b",
      home: { kind: "tool_call", toolUseId: "tool-1", toolName: "Edit" },
      file,
      span: { side: "new", startLine: 5, endLine: 6 },
    });
    expect(comment).toMatchObject({
      kind: "diff",
      path: "f",
      side: "new",
      startLine: 5,
      endLine: 6,
      outdated: false,
    });
    expect(comment?.hunk.split("\n")).toEqual([
      "@@ -3,6 +3,7 @@",
      " l3",
      " l4",
      " l5",
      "+X",
    ]);
    // Truncated at the last commented row, then sent to the agent.
    expect(formatTextCommentsForReply([comment!], "")).toContain(
      "   +X\n   ```\n"
    );
  });

  it("returns null for a line the patch does not show", () => {
    expect(
      createDiffComment({
        id: "c",
        body: "b",
        home: { kind: "worktree", wholeBranch: false },
        file: worktree.files[0],
        span: { side: "new", startLine: 1, endLine: 1 },
      })
    ).toBeNull();
  });
});

describe("computePlacements", () => {
  it("draws a tool-call comment on its call and on All Changes", () => {
    const comment = diffComment({
      home: { kind: "tool_call", toolUseId: "tool-1" },
    });
    const placements = computePlacements([comment], chain, worktree);
    expect(placements).toEqual([
      {
        commentId: "c1",
        surface: { kind: "tool_call", toolUseId: "tool-1" },
        path: "f",
        side: "new",
        startLine: 6,
        endLine: 6,
        home: true,
      },
      {
        commentId: "c1",
        surface: { kind: "worktree" },
        path: "f",
        side: "new",
        startLine: 6,
        endLine: 6,
        home: false,
      },
    ]);
  });

  it("draws an All Changes comment on the call that produced the line only", () => {
    const comment = diffComment({
      home: { kind: "worktree", wholeBranch: false },
    });
    const placements = computePlacements([comment], chain, worktree);
    expect(placements.map((p) => [p.surface, p.home, p.startLine])).toEqual([
      [{ kind: "worktree" }, true, 6],
      [{ kind: "tool_call", toolUseId: "tool-1" }, false, 6],
    ]);
  });

  it("draws a removed line's comment on the removing call", () => {
    const comment = diffComment({
      home: { kind: "worktree", wholeBranch: false },
      side: "old",
      startLine: 12,
      endLine: 12,
    });
    const placements = computePlacements([comment], chain, worktree);
    expect(placements.find((p) => !p.home)).toMatchObject({
      surface: { kind: "tool_call", toolUseId: "tool-2" },
      side: "old",
      startLine: 13,
    });
  });

  it("splits a range into runs where the target lines are not contiguous", () => {
    // tool-1 adds A..E (new lines 3-7); tool-2 inserts Q between B and C.
    const s1 = [...BASE.slice(0, 2), "A", "B", "C", "D", "E", ...BASE.slice(2)];
    const s2 = [...s1.slice(0, 4), "Q", ...s1.slice(4)];
    const split = chainOf(
      filePatch({ path: "f", before: BASE, after: s1 }),
      filePatch({ path: "f", before: s1, after: s2 })
    );
    const wt = parseWorktreeSnapshot(false, [
      filePatch({ path: "f", before: BASE, after: s2 }),
    ]);
    const comment = diffComment({
      home: { kind: "tool_call", toolUseId: "tool-1" },
      startLine: 3,
      endLine: 7,
    });
    const placements = computePlacements([comment], split, wt);
    expect(
      placements.filter((p) => !p.home).map((p) => [p.startLine, p.endLine])
    ).toEqual([
      [3, 4],
      [6, 8],
    ]);
  });

  it("omits All Changes when a later call removed the line", () => {
    const removed = chainOf(
      filePatch({ path: "f", before: BASE, after: withX }),
      filePatch({ path: "f", before: withX, after: BASE })
    );
    const wt = parseWorktreeSnapshot(false, [
      filePatch({ path: "f", before: BASE, after: BASE }),
    ]);
    const comment = diffComment({
      home: { kind: "tool_call", toolUseId: "tool-1" },
    });
    expect(computePlacements([comment], removed, wt)).toHaveLength(1);
  });

  it("draws a tool-call comment before All Changes has loaded", () => {
    const comment = diffComment({
      home: { kind: "tool_call", toolUseId: "tool-1" },
    });
    expect(computePlacements([comment], chain, null)).toHaveLength(1);
  });

  it("does not draw anything for a patch that is not loaded", () => {
    const comment = diffComment({
      home: { kind: "tool_call", toolUseId: "missing" },
    });
    expect(computePlacements([comment], chain, worktree)).toEqual([]);
    expect(
      computePlacements(
        [diffComment({ home: { kind: "worktree", wholeBranch: false } })],
        chain,
        null
      )
    ).toEqual([]);
  });

  it("keeps an outdated All Changes comment at its lines, or at file level", () => {
    const outdated = diffComment({
      home: { kind: "worktree", wholeBranch: false },
      outdated: true,
    });
    expect(computePlacements([outdated], chain, worktree)).toEqual([
      expect.objectContaining({ home: true, startLine: 6, endLine: 6 }),
    ]);
    const gone = diffComment({
      home: { kind: "worktree", wholeBranch: false },
      outdated: true,
      startLine: 40,
      endLine: 41,
    });
    expect(computePlacements([gone], chain, worktree)).toEqual([
      expect.objectContaining({ home: true, startLine: 0, endLine: 0 }),
    ]);
  });
});

describe("reconcileWorktreeComments", () => {
  const file = worktree.files[0];
  const base = createDiffComment({
    id: "w",
    body: "b",
    home: { kind: "worktree", wholeBranch: false },
    file,
    span: { side: "new", startLine: 6, endLine: 6 },
  })!;

  it("returns the same array when the patch is unchanged", () => {
    const comments = [base];
    expect(reconcileWorktreeComments(comments, worktree)).toBe(comments);
  });

  it("marks a comment outdated when its hunk differs, and clears it again", () => {
    const moved: WorktreeSnapshot = parseWorktreeSnapshot(true, [
      filePatch({
        path: "f",
        before: ["new first", ...BASE],
        after: withoutL12,
      }),
    ]);
    const [outdated] = reconcileWorktreeComments([base], moved);
    expect(outdated).toMatchObject({ outdated: true, hunk: base.hunk });
    const [back] = reconcileWorktreeComments([outdated], worktree);
    expect(back).toMatchObject({ outdated: false });
  });

  it("marks a comment outdated when its file is no longer changed", () => {
    const [outdated] = reconcileWorktreeComments(
      [base],
      parseWorktreeSnapshot(false, [])
    );
    expect(outdated).toMatchObject({ outdated: true });
  });

  it("leaves tool-call and text comments alone", () => {
    const tool = diffComment({
      home: { kind: "tool_call", toolUseId: "tool-1" },
    });
    const comments = [tool];
    expect(
      reconcileWorktreeComments(comments, parseWorktreeSnapshot(false, []))
    ).toBe(comments);
  });
});

describe("buildToolChain", () => {
  const annotation = (id: string, recorded_at: string, patch: string) => ({
    worktree_delta: {
      session_id: "s",
      tool_id: id,
      kind: "worktree_delta",
      recorded_at,
      payload: {
        patch,
        files: [{ path: "f", status: "modified" }],
      },
    },
  });

  it("orders calls by recording time and skips entries without a patch", () => {
    const patch = filePatch({ path: "f", before: ["a"], after: ["b"] });
    const chainByTime = buildToolChain({
      late: annotation("late", "2026-01-01T00:00:02Z", patch),
      early: annotation("early", "2026-01-01T00:00:01Z", patch),
      none: annotation("none", "2026-01-01T00:00:03Z", ""),
      other: {
        something: {
          session_id: "s",
          tool_id: "other",
          kind: "something",
          recorded_at: "2026-01-01T00:00:00Z",
          payload: {},
        },
      },
    });
    expect(chainByTime.map((p) => p.id)).toEqual(["early", "late"]);
    expect(canonicalPath(chainByTime[0].files[0])).toBe("f");
    expect(buildToolChain(undefined)).toEqual([]);
  });
});

it("invalidates identical hunks when the resolved comparison identity changes", () => {
  const snapshot = { ...worktree, comparisonIdentity: "feature-A..feature-B" };
  const comment = createDiffComment({
    id: "identity",
    body: "note",
    home: {
      kind: "worktree",
      wholeBranch: false,
      comparisonIdentity: snapshot.comparisonIdentity,
    },
    file: snapshot.files[0],
    span: { side: "new", startLine: 6, endLine: 6 },
  })!;
  expect(reconcileWorktreeComments([comment], snapshot)[0]).toMatchObject({
    outdated: false,
  });
  expect(
    reconcileWorktreeComments([comment], {
      ...snapshot,
      comparisonIdentity: "main..feature-B",
    })[0]
  ).toMatchObject({ outdated: true });
});
