import { describe, expect, it, beforeEach } from "vitest";
import { usePanelFocusStore, selectFocusedPanel } from "./panelFocusStore";

const focused = () => selectFocusedPanel(usePanelFocusStore.getState());

describe("panelFocusStore", () => {
  beforeEach(() => usePanelFocusStore.getState().reset());

  it("has no focused panel when empty", () => {
    expect(focused()).toBeNull();
  });

  it("focuses the most recently opened panel", () => {
    const { open } = usePanelFocusStore.getState();
    open("task-detail");
    open("chat");
    expect(usePanelFocusStore.getState().stack).toEqual(["task-detail", "chat"]);
    expect(focused()).toBe("chat");
  });

  it("re-opening an already-open panel raises it to focused (no duplicates)", () => {
    const { open } = usePanelFocusStore.getState();
    open("task-detail");
    open("chat");
    open("task-detail");
    expect(usePanelFocusStore.getState().stack).toEqual(["chat", "task-detail"]);
    expect(focused()).toBe("task-detail");
  });

  it("focus() raises an open panel to the top", () => {
    const { open, focus } = usePanelFocusStore.getState();
    open("task-detail");
    open("chat");
    focus("task-detail");
    expect(focused()).toBe("task-detail");
  });

  it("closing the focused panel falls back to the next-most-recent", () => {
    const { open, close } = usePanelFocusStore.getState();
    open("task-detail");
    open("chat");
    close("chat");
    expect(focused()).toBe("task-detail");
    close("task-detail");
    expect(focused()).toBeNull();
  });

  it("closing a background panel leaves focus untouched", () => {
    const { open, close } = usePanelFocusStore.getState();
    open("task-detail");
    open("chat");
    close("task-detail");
    expect(usePanelFocusStore.getState().stack).toEqual(["chat"]);
    expect(focused()).toBe("chat");
  });
});
