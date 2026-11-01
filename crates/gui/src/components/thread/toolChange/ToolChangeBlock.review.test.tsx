import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolChangeBlock } from "./ToolChangeBlock";
import { DiffReviewContext, type DiffReviewValue } from "./DiffReviewContext";
import { computePlacements, createDiffComment } from "./diffComments";
import { parsePatch } from "./diffLineMapper";
import { filePatch, numbered } from "./diffPatchBuilder.test.helpers";
import { parseWorktreeDelta } from "./worktreeDelta";

const near = vi.hoisted(() => ({ value: false }));
const annotations = vi.hoisted(() => ({
  seen: [] as unknown[],
  mounts: 0,
}));

vi.mock("../../../hooks/useNearViewport", () => ({
  useNearViewport: () => near.value,
}));

vi.mock("@pierre/diffs/react", async () => {
  const { createContext } = await import("react");
  return {
    WorkerPoolContext: createContext(undefined),
    FileDiff: ({ lineAnnotations }: { lineAnnotations?: unknown[] }) => {
      annotations.mounts += 1;
      annotations.seen.push(lineAnnotations);
      return <div data-testid="patch-diff" />;
    },
  };
});

const BASE = numbered("l", 10);
const PATCH = filePatch({
  path: "f.ts",
  before: BASE,
  after: [...BASE.slice(0, 4), "X", ...BASE.slice(4)],
});
const delta = parseWorktreeDelta({
  patch: PATCH,
  files: [{ path: "f.ts", status: "modified" }],
})!;

function value(): DiffReviewValue {
  const chain = [{ id: "t1", files: parsePatch(PATCH) }];
  const comment = createDiffComment({
    id: "c1",
    body: "Why X?",
    home: { kind: "tool_call", toolUseId: "t1", toolName: "Edit" },
    file: chain[0].files[0],
    span: { side: "new", startLine: 5, endLine: 5 },
  })!;
  return {
    comments: [comment],
    placements: computePlacements([comment], chain, null),
    chain,
    worktree: null,
    focus: null,
    addComment: vi.fn(),
    updateComment: vi.fn(),
    removeComment: vi.fn(),
  };
}

function renderBlock(children?: ReactNode) {
  return render(
    <DiffReviewContext.Provider value={value()}>
      {children ?? (
        <ToolChangeBlock delta={delta} toolName="Edit" toolId="t1" />
      )}
    </DiffReviewContext.Provider>
  );
}

describe("ToolChangeBlock with review comments", () => {
  beforeEach(() => {
    annotations.seen.length = 0;
    annotations.mounts = 0;
    near.value = false;
  });

  it("does not mount Pierre for a far-away diff even when it has comments", () => {
    renderBlock();
    expect(screen.getByTestId("diff-placeholder")).toBeInTheDocument();
    expect(screen.queryByTestId("patch-diff")).toBeNull();
    expect(annotations.mounts).toBe(0);
  });

  it("shows the comment once the diff is near the viewport", async () => {
    const view = renderBlock();
    near.value = true;
    view.rerender(
      <DiffReviewContext.Provider value={value()}>
        <ToolChangeBlock delta={delta} toolName="Edit" toolId="t1" />
      </DiffReviewContext.Provider>
    );
    expect(await screen.findByTestId("patch-diff")).toBeInTheDocument();
    expect(annotations.seen[annotations.seen.length - 1]).toEqual([
      {
        side: "additions",
        lineNumber: 5,
        metadata: { commentIds: ["c1"], draft: false },
      },
    ]);
  });

  it("offers no comments for a block without a tool id", async () => {
    near.value = true;
    renderBlock(<ToolChangeBlock delta={delta} toolName="Edit" />);
    await screen.findByTestId("patch-diff");
    expect(annotations.seen[annotations.seen.length - 1]).toBeUndefined();
  });
});
