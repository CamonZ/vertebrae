import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, type Task } from "../bindings";
import { queryClient, queryKeys, upsertTaskInQueryCache } from "../query";
import {
  getProjectScopeGeneration,
  resetProjectScopedStores,
} from "../stores/projectScopedStores";
import { createMockTask } from "../test/test-utils";
import type { LocalChatSessionGroup } from "../utils/localChatSessionGroups";
import { useLocalChatCompletedSessions } from "./useLocalChatCompletedSessions";

vi.mock("../bindings", () => ({ commands: { getTask: vi.fn() } }));

function group(projectId = "a", current = true): LocalChatSessionGroup {
  return {
    id: projectId,
    label: projectId,
    projectId,
    projectPath: `/${projectId}`,
    isCurrentProject: current,
    isFallback: false,
    sessions: ["ticket", "task", "missing", null].map((id, index) => ({
      id: `chat-${index}`,
      label: "Chat",
      harness: "claude",
      lifecycle: "idle",
      createdAt: "2026-01-01",
      updatedAt: "2026-01-01",
      projectPath: `/${projectId}`,
      providerResumeId: null,
      messageCount: 1,
      association: id ? { ticketId: id } : null,
    })),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  queryClient.clear();

  vi.mocked(commands.getTask).mockImplementation(async (id) => {
    if (id === "missing") throw new Error("Unavailable");

    return {
      status: "ok",
      data: createMockTask({
        id,
        level: id === "task" ? "task" : "ticket",
        completed_at: "2026-01-02",
      }),
    };
  });
});

describe("local chat completion metadata", () => {
  it("uses cached list completion immediately without fetching task details", () => {
    const generation = getProjectScopeGeneration();
    queryClient.setQueryData(queryKeys.tasks.list(generation, null), [
      createMockTask({ id: "ticket", completed_at: "2026-01-02" }),
      createMockTask({ id: "task", completed_at: null }),
      createMockTask({ id: "missing", completed_at: null }),
    ]);

    const { result } = renderHook(() => useLocalChatCompletedSessions(group()));

    expect([...result.current]).toEqual(["chat-0"]);
    expect(commands.getTask).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(queryKeys.tasks.detail(generation, "ticket"))
    ).toBeUndefined();
  });

  it("combines filtered lists and details, fetching only associations absent from both", async () => {
    const generation = getProjectScopeGeneration();
    queryClient.setQueryData(
      queryKeys.tasks.list(generation, {
        step_names: null,
        levels: ["ticket"],
        tags: null,
        root_only: null,
        children_of: null,
        search: null,
        workflow_id: null,
        step_id: null,
      }),
      [createMockTask({ id: "ticket", completed_at: "2026-01-02" })]
    );
    queryClient.setQueryData(
      queryKeys.tasks.detail(generation, "task"),
      createMockTask({ id: "task", completed_at: null })
    );

    const { result } = renderHook(() => useLocalChatCompletedSessions(group()));

    expect([...result.current]).toEqual(["chat-0"]);

    await waitFor(() => expect(commands.getTask).toHaveBeenCalledTimes(1));
    expect(commands.getTask).toHaveBeenCalledWith("missing");
  });

  it("observes cached list completion and reopening without creating detail records", async () => {
    const generation = getProjectScopeGeneration();
    const key = queryKeys.tasks.list(generation, null);
    queryClient.setQueryData(key, [
      createMockTask({ id: "ticket", completed_at: null }),
    ]);
    const single = { ...group(), sessions: group().sessions.slice(0, 1) };

    const { result } = renderHook(() => useLocalChatCompletedSessions(single));

    expect(result.current.size).toBe(0);

    act(() =>
      queryClient.setQueryData(key, [
        createMockTask({ id: "ticket", completed_at: "2026-01-02" }),
      ])
    );

    await waitFor(() => expect(result.current.has("chat-0")).toBe(true));

    act(() =>
      queryClient.setQueryData(key, [
        createMockTask({ id: "ticket", completed_at: null }),
      ])
    );

    await waitFor(() => expect(result.current.size).toBe(0));
    expect(commands.getTask).not.toHaveBeenCalled();
    expect(
      queryClient.getQueryData(queryKeys.tasks.detail(generation, "ticket"))
    ).toBeUndefined();
  });

  it("prefers newer task metadata when cached lists and details disagree", () => {
    const generation = getProjectScopeGeneration();
    queryClient.setQueryData(queryKeys.tasks.list(generation, null), [
      createMockTask({
        id: "ticket",
        completed_at: null,
        updated_at: "2026-01-03",
      }),
      createMockTask({
        id: "task",
        completed_at: "2026-01-02",
        updated_at: "2026-01-01",
      }),
    ]);
    queryClient.setQueryData(
      queryKeys.tasks.detail(generation, "ticket"),
      createMockTask({
        id: "ticket",
        completed_at: "2026-01-02",
        updated_at: "2026-01-01",
      })
    );
    queryClient.setQueryData(
      queryKeys.tasks.detail(generation, "task"),
      createMockTask({
        id: "task",
        completed_at: null,
        updated_at: "2026-01-03",
      })
    );

    const known = { ...group(), sessions: group().sessions.slice(0, 2) };
    const { result } = renderHook(() => useLocalChatCompletedSessions(known));

    expect(result.current.size).toBe(0);
    expect(commands.getTask).not.toHaveBeenCalled();
  });

  it("uses canonical completion for tickets and tasks, leaving missing and general chats visible", async () => {
    const { result } = renderHook(() => useLocalChatCompletedSessions(group()));

    expect(result.current.size).toBe(0);

    await waitFor(() =>
      expect([...result.current]).toEqual(["chat-0", "chat-1"])
    );

    expect(commands.getTask).toHaveBeenCalledTimes(3);
  });

  it("reacts to live completion and reopening without treating a finished run as completion", async () => {
    vi.mocked(commands.getTask).mockResolvedValue({
      status: "ok",
      data: createMockTask({
        id: "ticket",
        completed_at: null,
        step_type: "finish",
      }),
    });

    const single = { ...group(), sessions: group().sessions.slice(0, 1) };

    const { result } = renderHook(() => useLocalChatCompletedSessions(single));

    await waitFor(() =>
      expect(
        queryClient.getQueryData(
          queryKeys.tasks.detail(getProjectScopeGeneration(), "ticket")
        )
      ).toBeDefined()
    );

    expect(result.current.size).toBe(0);

    act(() =>
      upsertTaskInQueryCache(
        createMockTask({ id: "ticket", completed_at: "2026-01-02" })
      )
    );

    await waitFor(() => expect(result.current.has("chat-0")).toBe(true));

    act(() =>
      upsertTaskInQueryCache(
        createMockTask({ id: "ticket", completed_at: null })
      )
    );

    await waitFor(() => expect(result.current.size).toBe(0));
  });

  it("keeps other projects out of the active task cache and refreshes them on revisit", async () => {
    const generation = getProjectScopeGeneration();
    queryClient.setQueryData(queryKeys.tasks.list(generation, null), [
      createMockTask({ id: "ticket", completed_at: null }),
      createMockTask({ id: "task", completed_at: null }),
    ]);

    const { result, rerender } = renderHook(
      ({ selected }) => useLocalChatCompletedSessions(selected),
      { initialProps: { selected: group("b", false) } }
    );

    await waitFor(() => expect(result.current.size).toBe(2));
    expect(
      queryClient.getQueryData(queryKeys.tasks.detail(generation, "ticket"))
    ).toBeUndefined();
    expect(
      queryClient.getQueryData(
        queryKeys.localChatCompletion(generation, "b", "ticket")
      )
    ).toBeDefined();

    rerender({ selected: { ...group("c", false), sessions: [] } });
    expect(result.current.size).toBe(0);

    vi.mocked(commands.getTask).mockImplementation(async (id) => ({
      status: "ok",
      data: createMockTask({ id, completed_at: null }),
    }));

    rerender({ selected: group("b", false) });

    await waitFor(() => expect(result.current.size).toBe(0));
  });

  it("preserves a newer live completion while a task read is pending", async () => {
    let resolve!: (value: { status: "ok"; data: Task }) => void;

    vi.mocked(commands.getTask).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );

    const single = { ...group(), sessions: group().sessions.slice(0, 1) };

    const { result } = renderHook(() => useLocalChatCompletedSessions(single));

    act(() =>
      upsertTaskInQueryCache(
        createMockTask({
          id: "ticket",
          completed_at: "2026-01-02",
          updated_at: "2026-01-02",
        })
      )
    );

    await act(async () =>
      resolve({
        status: "ok",
        data: createMockTask({
          id: "ticket",
          completed_at: null,
          updated_at: "2026-01-01",
        }),
      })
    );

    await waitFor(() => expect(result.current.has("chat-0")).toBe(true));
  });

  it("retires pending metadata across project generations", async () => {
    let resolve!: (value: { status: "ok"; data: Task }) => void;

    vi.mocked(commands.getTask).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        })
    );

    const { result, rerender } = renderHook(
      ({ selected }) => useLocalChatCompletedSessions(selected),
      {
        initialProps: {
          selected: { ...group(), sessions: group().sessions.slice(0, 1) },
        },
      }
    );

    act(() => {
      resetProjectScopedStores();

      rerender({ selected: { ...group("b"), sessions: [] } });
    });

    await act(async () =>
      resolve({
        status: "ok",
        data: createMockTask({ id: "ticket", completed_at: "2026-01-02" }),
      })
    );

    expect(result.current.size).toBe(0);
    expect(
      queryClient.getQueryData(
        queryKeys.tasks.detail(getProjectScopeGeneration(), "ticket")
      )
    ).toBeUndefined();
  });

  it("refreshes other-project completion periodically and fails open on unavailable metadata", async () => {
    vi.useFakeTimers();

    try {
      const foreign = {
        ...group("b", false),
        sessions: group("b", false).sessions.slice(0, 1),
      };

      const { result, unmount } = renderHook(() =>
        useLocalChatCompletedSessions(foreign)
      );

      await act(async () => {
        await vi.advanceTimersByTimeAsync(10);
      });

      expect(result.current.has("chat-0")).toBe(true);

      vi.mocked(commands.getTask).mockResolvedValue({
        status: "ok",
        data: createMockTask({ id: "ticket", completed_at: null }),
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_010);
      });

      expect(result.current.size).toBe(0);

      vi.mocked(commands.getTask).mockResolvedValue({
        status: "ok",
        data: createMockTask({ id: "ticket", completed_at: "2026-01-02" }),
      });

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_010);
      });

      expect(result.current.has("chat-0")).toBe(true);

      vi.mocked(commands.getTask).mockRejectedValue(new Error("Offline"));

      await act(async () => {
        await vi.advanceTimersByTimeAsync(30_010);
      });

      expect(result.current.size).toBe(0);

      unmount();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not fetch metadata for unknown project chats", () => {
    const { result } = renderHook(() =>
      useLocalChatCompletedSessions({ ...group(), projectId: null })
    );

    expect(result.current.size).toBe(0);
    expect(commands.getTask).not.toHaveBeenCalled();
  });
});
