import { act, render, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import { useChatStore } from "../stores/chatStore";
import { associationDriverSessionIds } from "../utils/chatAssociation/driverSessions";
import { ChatAssociationDrivers } from "./ChatAssociationDrivers";

vi.mock("../bindings", () => ({
  commands: {
    resolveChatAssociation: vi.fn(),
    getCurrentProjectPath: vi.fn(),
    setLocalChatRecordingWorktree: vi.fn(),
  },
}));
vi.mock("../stores/projectScopedStores", () => ({
  getProjectScopeGeneration: vi.fn(() => 0),
}));
vi.mock("../utils/chatAssociation/candidates", () => ({
  cachedAssociationCandidates: () => [],
}));

const resolve = vi.mocked(commands.resolveChatAssociation);
const worktree = { path: "/p/.claude/worktrees/b3d8a9c9", branch: "b3d8a9c9" };

const session = (id: string, extra: object = {}) => ({
  id,
  projectPath: "/p",
  messages: [],
  association: null,
  backendSessionId: null,
  ...extra,
});

describe("associationDriverSessionIds", () => {
  it("lists each live or open session once", () => {
    const ids = associationDriverSessionIds({
      sessions: {
        live: session("live", { backendSessionId: "local-live-1" }),
        pane: session("pane"),
        active: session("active"),
        both: session("both", { backendSessionId: "local-both-1" }),
        history: session("history"),
      },
      activeSessionId: "active",
      paneLayout: {
        panes: [
          { id: "p1", sessionId: "pane" },
          { id: "p2", sessionId: "both" },
        ],
        activePaneId: "p1",
      },
    } as never);

    expect(ids).toEqual(["active", "both", "live", "pane"]);
  });
});

describe("ChatAssociationDrivers", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(commands.setLocalChatRecordingWorktree).mockResolvedValue({
      status: "ok",
      data: null,
    } as never);
  });

  it("resolves a live session's association and recording target with no window open", async () => {
    resolve.mockResolvedValue({
      status: "ok",
      data: {
        selection: { kind: "keep" },
        worktrees: [worktree],
        create_worktree: false,
        diagnostic: null,
      },
    } as never);
    useChatStore.setState({
      sessions: {
        s1: session("s1", {
          backendSessionId: "local-s1-1",
          lifecycle: "streaming",
          association: {
            ticketId: "b3d8a9c9-11cf-4d00-9a4b-c426be34bd29",
            ticketTitle: "Record",
            worktreePath: null,
            branch: null,
            lastProcessedAt: null,
            processedAtCount: 0,
            awaitingWorktree: null,
            recentWorktrees: [],
          },
        }),
      },
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
    } as never);
    render(<ChatAssociationDrivers />);

    act(() =>
      useChatStore.setState((state) => ({
        sessions: {
          s1: {
            ...state.sessions.s1,
            messages: [
              {
                kind: "tool_call",
                toolName: "Bash",
                toolId: "t1",
                input: `cd ${worktree.path}`,
                timestamp: "2026-10-28T00:00:01Z",
              },
            ],
          },
        },
      }))
    );

    await waitFor(() =>
      expect(commands.setLocalChatRecordingWorktree).toHaveBeenCalledWith(
        "local-s1-1",
        worktree.path
      )
    );
    expect(resolve).toHaveBeenCalledTimes(1);
  });
});
