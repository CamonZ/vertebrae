import { expect, it, vi } from "vitest";
import { commands, type ReviewThread } from "../../bindings";
import type { ChatSession } from "../../stores/chatStore";
import { parsePatch } from "../thread/toolChange/diffLineMapper";
import {
  readSavedDiscussion,
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
    checkoutPath: null,
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
  const rows: ReviewThread[] = [
    thread("left", "LEFT"),
    thread("right", "RIGHT"),
    { ...thread("missing-session", "RIGHT"), checkoutPath: "/checkout" },
    {
      ...thread("tool", "RIGHT"),
      checkoutPath: "/checkout",
      payload: {
        ...thread("tool", "RIGHT").payload,
        homeKind: "tool_call",
        toolUseId: "tool-id",
      },
    },
    thread("wrong-parent", "RIGHT", "other"),
    thread("wrong-checkout", "RIGHT"),
    thread("unreadable", "RIGHT"),
  ];
  const read = vi
    .spyOn(commands, "readReviewAnchor")
    .mockImplementation(async (_, id) =>
      id === "unreadable"
        ? { status: "error", error: "content_unavailable" }
        : { status: "ok", data: `${id}\n` }
    );
  const sessions = [
    session("left"),
    session("right"),
    { ...session("missing-session"), providerResumeId: null },
    session("wrong-parent"),
    session("wrong-checkout", "/another-worktree"),
    session("unreadable"),
  ];
  const snippets = new Map<string, Promise<string>>();
  const saved = (
    await Promise.all(
      rows.map((row) =>
        readSavedDiscussion(row, { worktreePath: "/checkout", parentChatId: "main" }, sessions, snippets)
      )
    )
  ).filter((record) => record !== null);
  expect(read.mock.calls.map(([path, id]) => [path, id])).toEqual([
    ["/checkout", "left"],
    ["/checkout", "right"],
    ["/checkout", "missing-session"],
    ["/checkout", "tool"],
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
    [null, "new", "missing-session"],
    [null, "new", "tool"],
    ["unreadable", "new", ""],
  ]);
  expect(restored[3].anchor.home).toEqual({
    kind: "tool_call",
    toolUseId: "tool-id",
  });
  expect(
    placeWorktreeDiscussions(saved, { files: [], wholeBranch: false })[2]
  ).toMatchObject({
    status: { kind: "detached" },
    anchor: { code: "missing-session" },
  });
  const controller = new SelectionDiscussions();
  controller.restore([...restored, ...restored]);
  controller.restore(restored);
  expect(controller.getSnapshot().threads).toEqual(restored);
  expect(controller.getSnapshot().activeId).toBeNull();

  // A local capture finishing after its catalog event activates the existing row.
  const { id, anchor, git } = restored[0];
  controller.ask(anchor, id, git.capture);
  expect(controller.getSnapshot().activeId).toBe(id);
  expect(controller.getSnapshot().threads).toEqual(restored);
});
