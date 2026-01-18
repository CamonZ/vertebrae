import { describe, it, expect, beforeEach } from "vitest";
import { useChatStore } from "./chatStore";

describe("chatStore", () => {
  beforeEach(() => {
    // Reset store state before each test
    useChatStore.setState({ sessionState: "idle" });
  });

  it("should have initial state as idle", () => {
    const state = useChatStore.getState();
    expect(state.sessionState).toBe("idle");
  });

  it("should update session state", () => {
    const store = useChatStore.getState();

    store.setSessionState("starting");
    expect(useChatStore.getState().sessionState).toBe("starting");

    store.setSessionState("running");
    expect(useChatStore.getState().sessionState).toBe("running");

    store.setSessionState("ended");
    expect(useChatStore.getState().sessionState).toBe("ended");

    store.setSessionState("error");
    expect(useChatStore.getState().sessionState).toBe("error");
  });

  it("should correctly report active state", () => {
    const store = useChatStore.getState();

    expect(store.isActive()).toBe(false);

    store.setSessionState("starting");
    expect(useChatStore.getState().isActive()).toBe(false);

    store.setSessionState("running");
    expect(useChatStore.getState().isActive()).toBe(true);

    store.setSessionState("ended");
    expect(useChatStore.getState().isActive()).toBe(false);

    store.setSessionState("error");
    expect(useChatStore.getState().isActive()).toBe(false);
  });
});
