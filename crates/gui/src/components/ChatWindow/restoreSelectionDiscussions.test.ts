import { expect, it, vi } from "vitest";
import { commands, type ReviewThread } from "../../bindings";
import type { ChatSession } from "../../stores/chatStore";
import { parsePatch } from "../thread/toolChange/diffLineMapper";
import {
  loadWorktreeDiscussions,
  placeWorktreeDiscussions,
} from "./restoreSelectionDiscussions";
import { SelectionDiscussions } from "./selectionDiscussions";

function thread(
  threadId: string,
  side: "LEFT" | "RIGHT",
  parentChatId = "main"
): ReviewThread {
  return {
    threadId,
    revision: 1,
    payload: {
      parentChatId,
      path: side === "LEFT" ? "old" : "new",
      side,
      homeKind: "worktree",
      toolUseId: null,
      originalCommitId: "commit",
      originalBlobId: "blob",
      originalStartLine: 1,
      originalLine: 1,
      startLine: 1,
      line: 1,
      status: "open",
      outdatedNoted: false,
      originKind: "local",
      originRef: null,
    },
  };
}

function session(
  reviewThreadId: string,
  worktreePath = "/checkout"
): ChatSession {
  return {
    id: reviewThreadId,
    label: "Discussion",
    harness: "claude",
    status: "open",
    messages: [],
    backendSessionId: null,
    providerResumeId: "resume",
    projectPath: "/project",
    discussion: { reviewThreadId, worktreePath, parentChatId: "main" },
  };
}

it("loads only readable anchors from the saved checkout and attaches their sessions", async () => {
  vi.spyOn(commands, "getProjects").mockResolvedValue({
    status: "ok",
    data: [{ path: "/project", project_id: "project", slug: "project" }],
  });
  vi.spyOn(commands, "listReviewThreads").mockResolvedValue({
    status: "ok",
    data: [
      thread("left", "LEFT"),
      thread("right", "RIGHT"),
      thread("missing-session", "RIGHT"),
      thread("wrong-parent", "RIGHT", "other"),
      thread("wrong-checkout", "RIGHT"),
      thread("unreadable", "RIGHT"),
    ],
  });
  const read = vi
    .spyOn(commands, "readReviewAnchor")
    .mockImplementation(async (_, id) =>
      id === "unreadable"
        ? { status: "error", error: "content_unavailable" }
        : { status: "ok", data: id }
    );
  const saved = await loadWorktreeDiscussions("/checkout", "/project", "main", [
    session("left"),
    session("right"),
    session("wrong-parent"),
    session("wrong-checkout", "/another-worktree"),
    session("unreadable"),
  ]);
  expect(read.mock.calls.map(([path, id]) => [path, id])).toEqual([
    ["/checkout", "left"],
    ["/checkout", "right"],
    ["/checkout", "unreadable"],
  ]);

  const files = parsePatch(
    "diff --git a/old b/new\n--- a/old\n+++ b/new\n@@ -1 +1 @@\n-before\n+after\n"
  );
  const restored = placeWorktreeDiscussions(saved, {
    files,
    wholeBranch: false,
  });
  expect(
    restored.map(({ sessionId, anchor }) => [
      sessionId,
      anchor.side,
      anchor.code,
    ])
  ).toEqual([
    ["left", "old", "left"],
    ["right", "new", "right"],
  ]);
  const controller = new SelectionDiscussions();
  expect(controller.restore([...restored, ...restored])).toBe(true);
  expect(controller.restore(restored)).toBe(false);
  expect(controller.getSnapshot().threads).toEqual(restored);
  expect(controller.getSnapshot().activeId).toBeNull();
});
