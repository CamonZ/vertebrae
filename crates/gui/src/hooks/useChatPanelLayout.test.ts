import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatPanelLayout } from "./useChatPanelLayout";
import { useShellStore } from "../stores/shellStore";
import { useChatStore } from "../stores/chatStore";
import { EMPTY_WORKSPACE } from "../stores/chatWorkspace";

const WIDTH_STORAGE_KEY = "chat-window-manager-width";

function renderPanelHook() {
  return renderHook(() => useChatPanelLayout());
}

/** A workspace with two open chats; collapsing must leave it intact. */
function seedWorkspace() {
  const layout = {
    ...EMPTY_WORKSPACE,
    order: [
      { id: "a", sessionId: "s-a" },
      { id: "b", sessionId: "s-b" },
    ],
    activeId: "b",
  };
  useChatStore.setState({ paneLayout: layout });
  return layout;
}

describe("useChatPanelLayout", () => {
  beforeEach(() => {
    localStorage.clear();
    useShellStore.setState({ chatPanelPresentation: "compact" });
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("initial width", () => {
    it("defaults to DEFAULT_PANEL_WIDTH when no stored value", () => {
      const { result } = renderPanelHook();
      expect(result.current.panelWidth).toBe(384);
    });

    it("reads the stored width from localStorage", () => {
      localStorage.setItem(WIDTH_STORAGE_KEY, "500");
      const { result } = renderPanelHook();
      expect(result.current.panelWidth).toBe(500);
    });

    it("clamps stored width above MAX_PANEL_WIDTH", () => {
      localStorage.setItem(WIDTH_STORAGE_KEY, "9999");
      const { result } = renderPanelHook();
      expect(result.current.panelWidth).toBe(760);
    });

    it("clamps stored width below MIN_PANEL_WIDTH", () => {
      localStorage.setItem(WIDTH_STORAGE_KEY, "100");
      const { result } = renderPanelHook();
      expect(result.current.panelWidth).toBe(320);
    });
  });

  describe("localStorage persistence", () => {
    it("persists panelWidth when not maximized", () => {
      const { result } = renderPanelHook();
      act(() => result.current.setPanelWidth(450));
      expect(localStorage.getItem(WIDTH_STORAGE_KEY)).toBe("450");
    });

    it("does not persist when maximized", () => {
      const { result } = renderPanelHook();
      // The initial render persists DEFAULT_PANEL_WIDTH when not maximized.
      // Clear it so we can verify no writes while maximized.
      localStorage.clear();
      act(() => result.current.toggleMaximized());
      act(() => result.current.setPanelWidth(450));
      expect(localStorage.getItem(WIDTH_STORAGE_KEY)).toBeNull();
    });
  });

  describe("toggleMaximized", () => {
    it("enters maximized state and computes maximizedWidth", () => {
      const { result } = renderPanelHook();
      act(() => result.current.toggleMaximized());
      expect(result.current.isMaximized).toBe(true);
      expect(result.current.maximizedWidth).toBeGreaterThan(0);
      expect(result.current.renderedPanelWidth).toBe(
        result.current.maximizedWidth
      );
    });

    it("restores the previous width when exiting maximize", () => {
      const { result } = renderPanelHook();
      const widthBefore = result.current.panelWidth;
      act(() => result.current.toggleMaximized());
      act(() => result.current.toggleMaximized());
      expect(result.current.isMaximized).toBe(false);
      expect(result.current.panelWidth).toBe(widthBefore);
      expect(result.current.renderedPanelWidth).toBe(widthBefore);
    });

    it("keeps the workspace layout when collapsing", () => {
      const layout = seedWorkspace();
      const { result } = renderPanelHook();
      act(() => result.current.toggleMaximized());
      act(() => result.current.toggleMaximized());
      expect(useChatStore.getState().paneLayout).toBe(layout);
    });
  });

  describe("resizePanel", () => {
    it("clamps new width to bounds", () => {
      const { result } = renderPanelHook();
      act(() => result.current.resizePanel(50));
      expect(result.current.panelWidth).toBe(320);

      act(() => result.current.resizePanel(9999));
      expect(result.current.panelWidth).toBe(760);
    });

    it("exits maximized state when resizing", () => {
      const { result } = renderPanelHook();
      act(() => result.current.toggleMaximized());
      expect(result.current.isMaximized).toBe(true);

      act(() => result.current.resizePanel(500));
      expect(result.current.isMaximized).toBe(false);
      expect(result.current.panelWidth).toBe(500);
    });

    it("keeps the workspace layout", () => {
      const layout = seedWorkspace();
      const { result } = renderPanelHook();
      act(() => result.current.resizePanel(500));
      expect(useChatStore.getState().paneLayout).toBe(layout);
    });
  });

  describe("resize drag", () => {
    it("sets isResizing on startResizeDrag", () => {
      const { result } = renderPanelHook();
      act(() => result.current.startResizeDrag());
      expect(result.current.isResizing).toBe(true);
    });

    it("widens leftward from the fixed right edge", () => {
      const { result } = renderPanelHook();
      Object.defineProperty(result.current.panelRef, "current", {
        configurable: true,
        value: {
          getBoundingClientRect: () => ({ right: 1000 }),
        },
      });

      act(() => result.current.startResizeDrag());
      act(() =>
        document.dispatchEvent(new MouseEvent("mousemove", { clientX: 500 }))
      );

      expect(result.current.panelWidth).toBe(500);
    });
  });

  describe("collapseMaximized", () => {
    it("restores width when maximized and keeps the workspace layout", () => {
      const layout = seedWorkspace();
      const { result } = renderPanelHook();
      const widthBefore = result.current.panelWidth;
      act(() => result.current.toggleMaximized());
      act(() => result.current.collapseMaximized());
      expect(result.current.isMaximized).toBe(false);
      expect(result.current.panelWidth).toBe(widthBefore);
      expect(useChatStore.getState().paneLayout).toBe(layout);
    });

    it("is a no-op when not maximized", () => {
      const layout = seedWorkspace();
      const { result } = renderPanelHook();
      act(() => result.current.collapseMaximized());
      expect(result.current.isMaximized).toBe(false);
      expect(useChatStore.getState().paneLayout).toBe(layout);
    });
  });

  describe("maximize width clamping", () => {
    it("computeMaximizedWidth respects the MIN_PANEL_WIDTH floor", () => {
      const { result } = renderPanelHook();
      // JSDOM has no painted rect, so the right edge falls back to the 12px
      // application inset. Wide chat preserves 60px at the left edge.
      const expected = Math.max(320, window.innerWidth - 12 - 60);
      expect(result.current.computeMaximizedWidth()).toBe(expected);
    });

    it("uses the painted right edge when available", () => {
      const { result } = renderPanelHook();
      Object.defineProperty(result.current.panelRef, "current", {
        configurable: true,
        value: {
          getBoundingClientRect: () => ({ right: 1100 }),
        },
      });

      expect(result.current.computeMaximizedWidth()).toBe(1040);
    });
  });

  describe("restoredPanelWidth", () => {
    it("stores the pre-maximize width as restoredPanelWidth", () => {
      const { result } = renderPanelHook();
      const originalWidth = result.current.panelWidth;
      act(() => result.current.resizePanel(500));
      act(() => result.current.toggleMaximized());
      // After maximize, restoredPanelWidth should be 500 (the width before maximizing)
      expect(result.current.restoredPanelWidth).toBe(500);
      // After un-maximize, panelWidth should restore to 500
      act(() => result.current.toggleMaximized());
      expect(result.current.panelWidth).toBe(500);
      void originalWidth;
    });
  });
});
