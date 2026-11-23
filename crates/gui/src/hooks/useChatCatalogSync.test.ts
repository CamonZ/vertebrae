import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  refresh: vi.fn(),
  apply: vi.fn(),
  generation: 1,
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
  unlisten: vi.fn(),
  deliver: vi.fn(),
}));

vi.mock("../bindings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../bindings")>()),
  commands: { deliverLocalChatCatalogOutbox: mocks.deliver },
}));

vi.mock("@tauri-apps/api/event", () => ({
  listen: (name: string, handler: (event: { payload: unknown }) => void) => {
    mocks.handlers.set(name, handler);
    return Promise.resolve(mocks.unlisten);
  },
}));

vi.mock("../stores/chatStore", () => ({
  useChatStore: {
    getState: () => ({
      refreshLocalSessionIndex: mocks.refresh,
      applyCatalogEntry: mocks.apply,
    }),
  },
}));

vi.mock("../stores/projectScopedStores", () => ({
  useProjectScopeGeneration: () => mocks.generation,
  isCurrentProjectScopeGeneration: (value: number) =>
    value === mocks.generation,
}));

import { useChatCatalogSync } from "./useChatCatalogSync";

describe("chat catalog recovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.generation = 1;
    mocks.handlers.clear();
    mocks.refresh.mockResolvedValue(undefined);
    mocks.deliver.mockResolvedValue({ status: "ok", data: null });
  });

  it("waits for explicit fallback invalidation before reading recovery snapshots", async () => {
    renderHook(useChatCatalogSync);
    expect(mocks.refresh).not.toHaveBeenCalled();

    act(() => mocks.handlers.get("chat-catalog-changed")!({ payload: "" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(1));

    act(() =>
      mocks.handlers.get("review-thread-catalog-recovery-needed")!({
        payload: { projectId: "project" },
      })
    );
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  });

  it("delivers the outbox on startup and reconnect without a recovery read", async () => {
    renderHook(useChatCatalogSync);
    await waitFor(() => expect(mocks.deliver).toHaveBeenCalledTimes(1));

    act(() =>
      mocks.handlers.get("websocket-state-changed")!({ payload: "disconnected" })
    );
    act(() =>
      mocks.handlers.get("websocket-state-changed")!({ payload: "connected" })
    );
    await waitFor(() => expect(mocks.deliver).toHaveBeenCalledTimes(2));
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("coalesces duplicate events but reads again after an in-flight snapshot", async () => {
    let finish!: () => void;
    mocks.refresh.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        })
    );

    renderHook(useChatCatalogSync);

    act(() => {
      for (let n = 0; n < 50; n++) {
        mocks.handlers.get("chat-catalog-changed")!({ payload: "" });
      }
    });
    expect(mocks.refresh).toHaveBeenCalledTimes(1);

    await act(async () => finish());
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));
  });

  it("retires an old scope and in-flight response on project change or unmount", async () => {
    const { rerender, unmount } = renderHook(useChatCatalogSync);
    act(() => mocks.handlers.get("chat-catalog-changed")!({ payload: "" }));
    const oldGuard = mocks.refresh.mock.calls[0][0] as () => boolean;
    expect(oldGuard()).toBe(true);

    mocks.generation = 2;
    rerender();
    expect(oldGuard()).toBe(false);

    act(() => mocks.handlers.get("chat-catalog-changed")!({ payload: "" }));
    const newGuard = mocks.refresh.mock.calls.at(-1)![0] as () => boolean;
    expect(newGuard()).toBe(true);

    unmount();
    expect(newGuard()).toBe(false);
    await waitFor(() => expect(mocks.unlisten).toHaveBeenCalledTimes(8));
  });

  it("logs only a fixed diagnostic and retries after a transport failure", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    mocks.refresh.mockRejectedValueOnce(new Error("secret transcript"));

    renderHook(useChatCatalogSync);
    act(() => mocks.handlers.get("chat-catalog-changed")!({ payload: "" }));
    await waitFor(() =>
      expect(warning).toHaveBeenCalledWith("[ChatCatalogSync] recovery_failed")
    );

    act(() => mocks.handlers.get("chat-catalog-changed")!({ payload: "" }));
    await waitFor(() => expect(mocks.refresh).toHaveBeenCalledTimes(2));

    warning.mockRestore();
  });

  it("applies CDC entries incrementally without any full recovery", async () => {
    renderHook(useChatCatalogSync);

    const session = { id: "chat", label: "Remote" };
    act(() => {
      for (let n = 0; n < 50; n++) {
        mocks.handlers.get("chat-catalog-entry-changed")!({
          payload: { sessionId: "chat", session },
        });
      }
      mocks.handlers.get("chat-catalog-entry-changed")!({
        payload: { sessionId: "gone", session: null },
      });
    });

    expect(mocks.apply).toHaveBeenCalledTimes(51);
    expect(mocks.apply).toHaveBeenCalledWith("chat", session);
    expect(mocks.apply).toHaveBeenLastCalledWith("gone", null);
    expect(mocks.refresh).not.toHaveBeenCalled();
  });

  it("ignores CDC entries delivered to a retired project scope", async () => {
    const { rerender } = renderHook(useChatCatalogSync);
    const staleHandler = mocks.handlers.get("chat-catalog-entry-changed")!;
    mocks.generation = 2;
    rerender();

    act(() => staleHandler({ payload: { sessionId: "chat", session: null } }));
    expect(mocks.apply).not.toHaveBeenCalled();
  });
});
