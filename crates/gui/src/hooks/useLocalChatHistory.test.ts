import { describe, it, expect, vi, beforeEach } from "vitest";
import { renderHook, act, waitFor } from "@testing-library/react";
import { useLocalChatHistory } from "./useLocalChatHistory";
import { useChatStore } from "../stores/chatStore";
import type { LocalChatSessionSummary } from "../utils/localChatPersistence";

vi.mock("../bindings", () => ({
  commands: {
    getCurrentProjectPath: vi.fn(),
    getProjects: vi.fn(),
  },
}));

vi.mock("../stores/projectScopedStores", () => ({
  useProjectScopeGeneration: () => 0,
}));

const mockedCommands = await import("../bindings").then((m) => m.commands);

function makeSummary(
  overrides: Partial<LocalChatSessionSummary> = {}
): LocalChatSessionSummary {
  return {
    id: "s1",
    label: "Chat 1",
    harness: "claude",
    preview: "hi",
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    projectPath: "/test/project",
    providerResumeId: null,
    messageCount: 1,
    lifecycle: "idle",
    ...overrides,
  };
}

describe("useLocalChatHistory", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
    });
    useChatStore.getState().listLocalSessions = vi.fn(() => []);
    vi.mocked(mockedCommands.getCurrentProjectPath).mockResolvedValue({
      status: "ok",
      data: "/test/project",
    });
    vi.mocked(mockedCommands.getProjects).mockResolvedValue({
      status: "ok",
      data: [
        { slug: "test-project", project_id: "p1", path: "/test/project" },
      ],
    });
  });

  it("loads current project path and saved projects on mount", async () => {
    renderHook(() => useLocalChatHistory({ sessionChangeToken: "" }));
    await waitFor(() => {
      expect(mockedCommands.getCurrentProjectPath).toHaveBeenCalled();
    });
    expect(mockedCommands.getProjects).toHaveBeenCalled();
  });

  it("exposes loadCurrentProjectPath that returns the path on success", async () => {
    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );
    const path = await result.current.loadCurrentProjectPath();
    expect(path).toBe("/test/project");
  });

  it("loadCurrentProjectPath returns null on error status", async () => {
    vi.mocked(mockedCommands.getCurrentProjectPath).mockResolvedValue({
      status: "error",
      error: { SendFailed: "fail" },
    } as never);
    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );
    const path = await result.current.loadCurrentProjectPath();
    expect(path).toBeNull();
  });

  it("loadCurrentProjectPath returns null on exception", async () => {
    vi.mocked(mockedCommands.getCurrentProjectPath).mockRejectedValue(
      new Error("net")
    );
    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );
    const path = await result.current.loadCurrentProjectPath();
    expect(path).toBeNull();
  });

  it("projectGroupingWarning is null when projects load successfully", async () => {
    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );
    await waitFor(() => {
      expect(result.current.projectGroupingWarning).toBeNull();
    });
  });

  it("projectGroupingWarning is set when getProjects returns error", async () => {
    vi.mocked(mockedCommands.getProjects).mockResolvedValue({
      status: "error",
      error: { SendFailed: "fail" },
    } as never);
    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );
    await waitFor(() => {
      expect(result.current.projectGroupingWarning).toContain(
        "Could not load saved projects"
      );
    });
  });

  it("projectGroupingWarning is set when getProjects throws", async () => {
    vi.mocked(mockedCommands.getProjects).mockRejectedValue(new Error("net"));
    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );
    await waitFor(() => {
      expect(result.current.projectGroupingWarning).toContain(
        "Could not load saved projects"
      );
    });
  });

  it("commitCurrentProjectPath updates the project path without error", async () => {
    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );
    await waitFor(() => expect(result.current.localSessionGroups).toBeDefined());

    expect(() =>
      result.current.commitCurrentProjectPath("/new/path")
    ).not.toThrow();
  });

  it("bumpHistoryRevision forces the grouping memo to recompute", async () => {
    let summaries: ReturnType<typeof makeSummary>[] = [];
    useChatStore.getState().listLocalSessions = vi.fn(() => summaries);

    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );

    await waitFor(() => expect(result.current.localSessionGroups).toBeDefined());
    const callsBefore = (
      useChatStore.getState().listLocalSessions as ReturnType<typeof vi.fn>
    ).mock.calls.length;

    summaries = [makeSummary({ id: "s1" })];

    act(() => result.current.bumpHistoryRevision());

    await waitFor(() => {
      const callsAfter = (
        useChatStore.getState().listLocalSessions as ReturnType<typeof vi.fn>
      ).mock.calls.length;
      expect(callsAfter).toBeGreaterThan(callsBefore);
    });
  });

  it("returns empty groups when no sessions and no summaries", async () => {
    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );
    await waitFor(() => expect(result.current.localSessionGroups).toBeDefined());
    expect(result.current.localSessionGroups).toEqual([]);
  });

  it("returns groups when summaries exist even with empty sessionChangeToken", async () => {
    const summary = makeSummary({ id: "s1", projectPath: "/test/project" });
    useChatStore.getState().listLocalSessions = vi.fn(() => [summary]);

    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );
    await waitFor(() => {
      expect(result.current.localSessionGroups.length).toBeGreaterThan(0);
    });
  });

  it("returns groups from summaries when sessionChangeToken is non-empty", async () => {
    const summary = makeSummary({ id: "s1", projectPath: "/test/project" });
    useChatStore.getState().listLocalSessions = vi.fn(() => [summary]);

    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "token" })
    );
    await waitFor(() => {
      expect(result.current.localSessionGroups.length).toBeGreaterThan(0);
    });
  });

  it("returns empty groups when summaries is empty but sessionChangeToken is non-empty", async () => {
    useChatStore.getState().listLocalSessions = vi.fn(() => []);

    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "token" })
    );
    await waitFor(() => expect(result.current.localSessionGroups).toBeDefined());
    expect(result.current.localSessionGroups).toEqual([]);
  });

  it("passes currentProjectPath to listLocalSessions when projectsLoadFailed", async () => {
    vi.mocked(mockedCommands.getProjects).mockResolvedValue({
      status: "error",
      error: { SendFailed: "fail" },
    } as never);
    const listMock = vi.fn(() => []);
    useChatStore.getState().listLocalSessions = listMock;

    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );

    await waitFor(() => {
      expect(result.current.projectGroupingWarning).toBeTruthy();
    });

    // When projects fail, listLocalSessions should be called with the current
    // project path (not undefined) to scope to the current project only.
    expect(listMock).toHaveBeenCalledWith("/test/project");
  });

  it("passes undefined to listLocalSessions when projects loaded ok", async () => {
    const listMock = vi.fn(() => []);
    useChatStore.getState().listLocalSessions = listMock;

    const { result } = renderHook(() =>
      useLocalChatHistory({ sessionChangeToken: "" })
    );

    await waitFor(() => {
      expect(result.current.projectGroupingWarning).toBeNull();
    });

    // When projects loaded OK, listLocalSessions gets undefined to show all.
    expect(listMock).toHaveBeenCalledWith(undefined);
  });
});
