import { act, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import { initialProviderReplayState } from "../stores/providerReplay";
import { useChatStore, type ChatSession } from "../stores/chatStore";
import { useChildChatSessions } from "./useChildChatSessions";

const root: ChatSession = {
  backendSessionId: null,
  id: "root",
  label: "Root",
  harness: "codex",
  status: "open",
  messages: [],
  providerResumeId: "root-thread",
  projectPath: "/fixture",
  lifecycle: "streaming",
};
const child = (id: string, active: boolean) => ({
  provider_resume_id: id,
  spawn_tool_call_id: `spawn-${id}`,
  label: id,
  is_active: active,
});

describe("child chat sessions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    useChatStore.setState({
      sessions: { root },
      paneLayout: { panes: [], activePaneId: null },
    });
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("discovers Codex children without replaying the parent, including nested children, and clears activity", async () => {
    let active = true;
    const discover = vi
      .spyOn(commands, "discoverLocalChatChildSessions")
      .mockImplementation(async (input) => ({
        status: "ok",
        data:
          input.provider_resume_id === "root-thread"
            ? [child("worker", active)]
            : input.provider_resume_id === "worker"
              ? [child("nested", false)]
              : [],
      }));
    const replay = vi.spyOn(commands, "loadLocalChatSessionReplay");

    const { result, unmount } = renderHook(() =>
      useChildChatSessions("root", true)
    );
    await act(async () => {});

    expect(result.current.get("root")).toMatchObject([
      { threadId: "worker", isWorking: true, depth: 0 },
      { threadId: "nested", isWorking: false, depth: 1 },
    ]);
    expect(replay).not.toHaveBeenCalled();

    active = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.get("root")?.[0].isWorking).toBe(false);

    unmount();
    const calls = discover.mock.calls.length;
    await vi.advanceTimersByTimeAsync(6000);
    expect(discover).toHaveBeenCalledTimes(calls);
  });

  it("retries a transient discovery failure after an idle parent starts background work", async () => {
    useChatStore.setState({
      sessions: { root: { ...root, lifecycle: "idle" } },
    });
    vi.spyOn(console, "warn").mockImplementation(() => {});
    let fail = false;
    let active = true;
    const discover = vi
      .spyOn(commands, "discoverLocalChatChildSessions")
      .mockImplementation(async (input) => {
        if (fail && input.provider_resume_id === "root-thread")
          throw new Error("transient read failure");
        return {
          status: "ok",
          data:
            input.provider_resume_id === "root-thread"
              ? [child("worker", active)]
              : [],
        };
      });

    const { result } = renderHook(() => useChildChatSessions("root", true));
    await act(async () => {});

    expect(result.current.get("root")?.[0].isWorking).toBe(true);

    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    const calls = discover.mock.calls.length;
    fail = false;
    active = false;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(6000);
    });
    expect(discover.mock.calls.length).toBeGreaterThan(calls);
    expect(result.current.get("root")?.[0].isWorking).toBe(false);
  });

  it("does not retire discovery when session tokens change during a slow scan", async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof commands.discoverLocalChatChildSessions>>
    ) => void;
    const discover = vi
      .spyOn(commands, "discoverLocalChatChildSessions")
      .mockImplementation((input) =>
        input.provider_resume_id === "root-thread"
          ? new Promise((done) => {
              resolve = done;
            })
          : Promise.resolve({ status: "ok", data: [] })
      );

    const { result, rerender } = renderHook(
      ({ token }) => useChildChatSessions(token, true),
      { initialProps: { token: "first" } }
    );
    rerender({ token: "streaming-1" });
    rerender({ token: "streaming-2" });
    await act(async () => {
      resolve({ status: "ok", data: [child("worker", true)] });
    });
    expect(result.current.get("root")?.[0].threadId).toBe("worker");
    expect(
      discover.mock.calls.filter(
        ([input]) => input.provider_resume_id === "root-thread"
      )
    ).toHaveLength(1);
  });

  it("backs off persistent failures and emits a repeated diagnostic only once", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const discover = vi
      .spyOn(commands, "discoverLocalChatChildSessions")
      .mockRejectedValue(new Error("unreadable transcript"));
    renderHook(() => useChildChatSessions("root", true));
    await act(async () => {});

    expect(discover).toHaveBeenCalledTimes(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(discover).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(discover).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(discover).toHaveBeenCalledTimes(3);
    expect(warning).toHaveBeenCalledTimes(1);
  });

  it("keeps live Claude activity when disk status is unknown and clears it on terminal evidence", async () => {
    useChatStore.setState({
      sessions: { root: { ...root, harness: "claude", lifecycle: "idle" } },
    });
    const childId = useChatStore.getState().ensureProviderThreadSession({
      harness: "claude",
      providerResumeId: "worker",
      ownerSessionId: "root",
    });
    useChatStore
      .getState()
      .setProviderChildActivity(childId, true, "working-turn");
    let finished = false;
    vi.spyOn(commands, "discoverLocalChatChildSessions").mockImplementation(
      async (input) => ({
        status: "ok",
        data:
          input.provider_resume_id === "root-thread"
            ? [
                {
                  ...child("worker", false),
                  is_active: finished ? false : null,
                },
              ]
            : [],
      })
    );

    const { result } = renderHook(() => useChildChatSessions("root", true));
    await act(async () => {});

    expect(result.current.get("root")?.[0].isWorking).toBe(true);
    finished = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(result.current.get("root")?.[0].isWorking).toBe(false);
  });

  it("loads an assignment that appears after the child header, then uses live updates", async () => {
    useChatStore.setState({
      sessions: {
        root: { ...root, backendSessionId: "live-owner", lifecycle: "idle" },
      },
    });
    const id = useChatStore.getState().ensureProviderThreadSession({
      harness: "codex",
      providerResumeId: "worker",
      ownerSessionId: "root",
    });
    useChatStore.setState((state) => ({
      sessions: {
        ...state.sessions,
        [id]: {
          ...state.sessions[id],
          providerReplay: {
            ...initialProviderReplayState(123),
            loading: null,
            loaded: true,
            cacheKey: "header-only",
          },
        },
      },
      paneLayout: {
        panes: [{ id: "pane", sessionId: id }],
        activePaneId: "pane",
      },
    }));
    vi.spyOn(commands, "discoverLocalChatChildSessions").mockImplementation(
      async (input) => ({
        status: "ok",
        data:
          input.provider_resume_id === "root-thread"
            ? [child("worker", true)]
            : [],
      })
    );
    const replay = vi
      .spyOn(commands, "loadLocalChatSessionReplay")
      .mockResolvedValue({
        status: "ok",
        data: {
          cache_key: "assignment-ready",
          next_cursor: null,
          has_more: false,
          events: [
            JSON.stringify({
              version: 1,
              event_id: "assignment",
              stream_id: "selected-worker",
              sequence: 1,
              timestamp: "2026-01-01T00:00:00Z",
              semantics: "snapshot",
              correlation: { thread_id: "worker" },
              type: "turn_input",
              data: {
                thread_id: "worker",
                content: "The assigned prompt",
                provenance: "agent",
              },
            }),
          ],
        },
      });
    renderHook(() => useChildChatSessions("root", true));
    await act(async () => {});

    expect(replay).toHaveBeenCalledTimes(1);
    expect(useChatStore.getState().sessions[id].providerReplay).toMatchObject({ cacheKey: "assignment-ready", loaded: true });
    expect(useChatStore.getState().sessions[id].messages).toContainEqual(
      expect.objectContaining({ kind: "user", text: "The assigned prompt" })
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
    });
    expect(replay).toHaveBeenCalledTimes(1);
  });

  it("discards late discovery after the panel closes", async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof commands.discoverLocalChatChildSessions>>
    ) => void;
    vi.spyOn(commands, "discoverLocalChatChildSessions").mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );

    const { result, rerender } = renderHook(
      ({ enabled }) => useChildChatSessions("root", enabled),
      { initialProps: { enabled: true } }
    );
    rerender({ enabled: false });
    await act(async () => {
      resolve({ status: "ok", data: [child("late", true)] });
    });
    expect(result.current.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps a failed nested transcript from hiding its selectable siblings and guards cycles", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const discover = vi
      .spyOn(commands, "discoverLocalChatChildSessions")
      .mockImplementation(async (input) => {
        if (input.provider_resume_id === "broken")
          throw new Error("unreadable");
        return {
          status: "ok",
          data:
            input.provider_resume_id === "root-thread"
              ? [child("broken", false), child("good", false)]
              : [child("root-thread", false)],
        };
      });

    const { result } = renderHook(() => useChildChatSessions("root", true));
    await act(async () => {});

    expect(result.current.get("root")?.map((row) => row.threadId)).toContain(
      "good"
    );
    expect(discover).toHaveBeenCalledTimes(3);
  });
});
