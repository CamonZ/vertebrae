import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { commands, events } from "../../../bindings";
import { useWorktreeWatch } from "./useWorktreeWatch";

vi.mock("../../../bindings", () => ({
  commands: { watchWorktree: vi.fn(), unwatchWorktree: vi.fn() },
  events: { worktreeChangedEvent: { listen: vi.fn() } },
}));
const watch = vi.mocked(commands.watchWorktree);
const stop = vi.mocked(commands.unwatchWorktree);
const listen = vi.mocked(events.worktreeChangedEvent.listen);
const unlisten = vi.fn();
beforeEach(() => {
  vi.clearAllMocks();
  watch.mockResolvedValue({ status: "ok", data: "watch-1" });
  stop.mockResolvedValue({ status: "ok", data: null });
  listen.mockResolvedValue(unlisten);
});
describe("worktree watch ownership", () => {
  it("refreshes only its own watch and releases native resources", async () => {
    const refresh = vi.fn();
    const { unmount } = renderHook(() =>
      useWorktreeWatch("/worktree", refresh)
    );
    await waitFor(() => expect(refresh).toHaveBeenCalledTimes(1));
    const callback = listen.mock.calls[0][0];
    act(() =>
      callback({
        event: "worktree-changed-event",
        id: 1,
        payload: { watch_id: "other" },
      })
    );
    expect(refresh).toHaveBeenCalledTimes(1);
    act(() =>
      callback({
        event: "worktree-changed-event",
        id: 1,
        payload: { watch_id: "watch-1" },
      })
    );
    expect(refresh).toHaveBeenCalledTimes(2);
    unmount();
    expect(unlisten).toHaveBeenCalledOnce();
    expect(stop).toHaveBeenCalledWith("watch-1");
    act(() =>
      callback({
        event: "worktree-changed-event",
        id: 1,
        payload: { watch_id: "watch-1" },
      })
    );
    expect(refresh).toHaveBeenCalledTimes(2);
  });
  it("releases a listener registered after disposal without starting a watch", async () => {
    let resolve!: (value: () => void) => void;
    listen.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const { unmount } = renderHook(() => useWorktreeWatch("/old", vi.fn()));
    unmount();
    await act(async () => resolve(unlisten));
    expect(unlisten).toHaveBeenCalledOnce();
    expect(watch).not.toHaveBeenCalled();
  });
  it("reports listener cleanup failure and still stops the native watch", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    unlisten.mockImplementationOnce(() => {
      throw new Error("unlisten failed");
    });
    const refresh = vi.fn();
    const { unmount } = renderHook(() =>
      useWorktreeWatch("/worktree", refresh)
    );
    await waitFor(() => expect(refresh).toHaveBeenCalled());
    unmount();
    expect(stop).toHaveBeenCalledWith("watch-1");
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
  it("stops a watch that finishes setup after disposal", async () => {
    let resolve!: (
      value: Awaited<ReturnType<typeof commands.watchWorktree>>
    ) => void;
    watch.mockReturnValue(
      new Promise((done) => {
        resolve = done;
      })
    );
    const refresh = vi.fn();
    const { unmount } = renderHook(() => useWorktreeWatch("/old", refresh));
    await waitFor(() => expect(watch).toHaveBeenCalledWith("/old"));
    unmount();
    await act(async () => resolve({ status: "ok", data: "late" }));
    expect(stop).toHaveBeenCalledWith("late");
    expect(refresh).not.toHaveBeenCalled();
  });
  it("exposes startup failure and releases the event listener", async () => {
    watch.mockResolvedValue({
      status: "error",
      error: { message: "watch limit" },
    });
    const { result } = renderHook(() => useWorktreeWatch("/worktree", vi.fn()));
    await waitFor(() => expect(result.current).toContain("watch limit"));
    expect(unlisten).toHaveBeenCalled();
  });
});
