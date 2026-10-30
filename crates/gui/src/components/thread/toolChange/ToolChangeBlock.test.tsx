import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../../stores/chatStore";
import { ChatSessionContext } from "./ChatSessionContext";
import { DEFAULT_DIFF_HEIGHT } from "./ResizableDiffViewport";
import { ToolRow } from "../EventRow";

vi.mock("@pierre/diffs/react", async () => {
  const { createContext } = await import("react");
  return {
    WorkerPoolContext: createContext(undefined),
    FileDiff: ({ fileDiff }: { fileDiff: { name: string } }) => (
      <div data-testid="patch-diff">{fileDiff.name}</div>
    ),
  };
});

function seed(payload: unknown) {
  useChatStore.setState({
    sessions: {
      s1: {
        toolAnnotations: {
          t1: {
            worktree_delta: {
              session_id: "s1",
              tool_id: "t1",
              kind: "worktree_delta",
              payload,
            },
          },
        },
      },
    },
  } as never);
}

function renderBlock(sessionId: string | null = "s1", toolId = "t1") {
  return render(
    <ChatSessionContext.Provider value={sessionId}>
      <ToolRow name="Edit" status="done" toolId={toolId} body="tool output" />
    </ChatSessionContext.Provider>
  );
}

const PATCH = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n";

describe("ToolRow with a recorded worktree delta", () => {
  beforeEach(() => useChatStore.setState({ sessions: {} } as never));

  it("renders the diff in place of the tool call", async () => {
    seed({ patch: PATCH, files: [{ path: "a", status: "modified" }] });
    renderBlock();
    expect(screen.getByText("1 file changed")).toBeTruthy();
    expect(screen.getByText("by Edit")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
    expect(screen.queryByText("tool output")).toBeNull();
    expect(await screen.findByTestId("patch-diff")).toBeTruthy();
    expect(screen.getByTestId("diff-viewport").style.maxHeight).toBe(
      `${DEFAULT_DIFF_HEIGHT}px`
    );
    expect(screen.getByRole("separator", { name: "Resize diff" })).toBeTruthy();
  });

  it("renders one diff per file for multi-file patches", async () => {
    const second = PATCH.replace(/\/a/g, "/b");
    seed({
      patch: PATCH + second,
      files: [
        { path: "a", status: "modified" },
        { path: "b", status: "modified" },
      ],
    });
    renderBlock();
    const diffs = await screen.findAllByTestId("patch-diff");
    expect(diffs.map((d) => d.textContent)).toEqual(["a", "b"]);
  });

  it("shows marker text for marker-only annotations", () => {
    seed({
      patch: "",
      files: [{ path: "b", status: "added", marker: { reason: "binary" } }],
    });
    renderBlock();
    expect(screen.getByText(/Binary file/)).toBeTruthy();
    expect(screen.queryByTestId("patch-diff")).toBeNull();
    expect(screen.queryByTestId("diff-viewport")).toBeNull();
  });

  it("keeps the tool call with an inline error for malformed payloads", () => {
    seed({ files: 3 });
    renderBlock();
    expect(screen.getByRole("button", { name: /Edit/ })).toBeTruthy();
    expect(screen.getByRole("status").textContent).toMatch(/could not be/);
  });

  it("renders the plain tool call without an annotation for its session", () => {
    seed({ patch: PATCH, files: [{ path: "a", status: "modified" }] });
    renderBlock("other");
    expect(screen.getByRole("button", { name: /Edit/ })).toBeTruthy();
    expect(screen.queryByTestId("tool-change-block")).toBeNull();
  });

  it("keeps a pending tool call until it settles", () => {
    seed({ patch: PATCH, files: [{ path: "a", status: "modified" }] });
    render(
      <ChatSessionContext.Provider value="s1">
        <ToolRow name="Edit" status="pending" toolId="t1" />
      </ChatSessionContext.Provider>
    );
    expect(screen.getByText("Edit")).toBeTruthy();
    expect(screen.queryByTestId("tool-change-block")).toBeNull();
  });
});
