import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore } from "../../../stores/chatStore";
import { ChatSessionContext } from "./ChatSessionContext";
import { ToolChangeBlock } from "./ToolChangeBlock";

vi.mock("@pierre/diffs/react", () => ({
  FileDiff: ({ fileDiff }: { fileDiff: { name: string } }) => (
    <div data-testid="patch-diff">{fileDiff.name}</div>
  ),
}));

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
      <ToolChangeBlock toolId={toolId} />
    </ChatSessionContext.Provider>
  );
}

const PATCH = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n";

describe("ToolChangeBlock", () => {
  beforeEach(() => useChatStore.setState({ sessions: {} } as never));

  it("shows a summary and renders the diff only when expanded", async () => {
    seed({ patch: PATCH, files: [{ path: "a", status: "modified" }] });
    renderBlock();
    expect(screen.getByText("1 file changed")).toBeTruthy();
    expect(screen.queryByTestId("patch-diff")).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    expect(await screen.findByTestId("patch-diff")).toBeTruthy();
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
    fireEvent.click(screen.getByRole("button"));
    const diffs = await screen.findAllByTestId("patch-diff");
    expect(diffs.map((d) => d.textContent)).toEqual(["a", "b"]);
  });

  it("shows marker text for marker-only annotations", () => {
    seed({
      patch: "",
      files: [{ path: "b", status: "added", marker: { reason: "binary" } }],
    });
    renderBlock();
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/Binary file/)).toBeTruthy();
    expect(screen.queryByTestId("patch-diff")).toBeNull();
  });

  it("shows an inline error for malformed payloads", () => {
    seed({ files: 3 });
    renderBlock();
    expect(screen.getByRole("status")).toBeTruthy();
  });

  it("renders nothing without an annotation or for another session", () => {
    seed({ patch: PATCH, files: [{ path: "a", status: "modified" }] });
    const { container } = renderBlock("other");
    expect(container.innerHTML).toBe("");
  });
});
