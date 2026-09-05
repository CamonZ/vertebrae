import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatPaneManagement } from "./useChatPaneManagement";
import {
  useChatStore,
  type ChatSession,
  type ChatPane,
  type ChatPaneLayout,
} from "../stores/chatStore";

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "s1",
    label: "Test",
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    ...overrides,
  };
}

function setStoreState(
  sessions: Record<string, ChatSession>,
  paneLayout: ChatPaneLayout,
  activeSessionId: string | null = "s1"
) {
  useChatStore.setState({
    sessions,
    paneLayout,
    activeSessionId,
  });
}

function renderPaneHook(opts: {
  isMaximized?: boolean;
  renderedPanelWidth?: number;
  activeSession?: ChatSession | null;
}) {
  return renderHook(
    ({ isMaximized, renderedPanelWidth, activeSession }) =>
      useChatPaneManagement({
        isMaximized,
        renderedPanelWidth,
        activeSessionId: activeSession?.id ?? null,
      }),
    {
      initialProps: {
        isMaximized: opts.isMaximized ?? false,
        renderedPanelWidth: opts.renderedPanelWidth ?? 400,
        activeSession: opts.activeSession ?? null,
      },
    }
  );
}

describe("useChatPaneManagement", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: { panes: [], activePaneId: null },
      panelOpen: false,
    });
  });

  describe("non-maximized mode", () => {
    it("renders a single fallback pane from the active session", () => {
      const session = makeSession({ id: "s1" });
      setStoreState({ s1: session }, { panes: [], activePaneId: null });
      const { result } = renderPaneHook({
        isMaximized: false,
        activeSession: session,
      });
      expect(result.current.visiblePanes).toHaveLength(1);
      expect(result.current.visiblePanes[0].sessionId).toBe("s1");
    });

    it("renders no panes when there is no active session", () => {
      const { result } = renderPaneHook({
        isMaximized: false,
        activeSession: null,
      });
      expect(result.current.visiblePanes).toHaveLength(0);
      expect(result.current.activePaneId).toBeNull();
    });

    it("canAddSplitPane is false when not maximized", () => {
      const session = makeSession();
      setStoreState({ s1: session }, { panes: [], activePaneId: null });
      const { result } = renderPaneHook({
        isMaximized: false,
        activeSession: session,
      });
      expect(result.current.canAddSplitPane).toBe(false);
    });
  });

  describe("maximized mode", () => {
    const pane1: ChatPane = { id: "p1", sessionId: "s1" };
    const pane2: ChatPane = { id: "p2", sessionId: "s2" };

    function setupMaximized(
      panes: ChatPane[],
      activePaneId: string | null,
      activeSession: ChatSession | null = null,
      renderedPanelWidth: number = 1000
    ) {
      const sessions: Record<string, ChatSession> = {};
      for (const pane of panes) {
        if (!sessions[pane.sessionId]) {
          sessions[pane.sessionId] = makeSession({ id: pane.sessionId });
        }
      }
      setStoreState(sessions, { panes, activePaneId });
      return renderPaneHook({
        isMaximized: true,
        renderedPanelWidth,
        activeSession,
      });
    }

    it("renders store panes when maximized", () => {
      const { result } = setupMaximized([pane1, pane2], "p1");
      expect(result.current.visiblePanes).toHaveLength(2);
      expect(result.current.activePaneId).toBe("p1");
    });

    it("falls back to first pane when activePaneId is null", () => {
      const { result } = setupMaximized([pane1, pane2], null);
      expect(result.current.activePaneId).toBe("p1");
    });

    it("canAddSplitPane is true when width is sufficient and panes < MAX", () => {
      const { result } = setupMaximized([pane1], "p1");
      // MINI_HISTORY_WIDTH(272) + MIN_SPLIT_PANE_WIDTH(360)*2 = 992
      // renderedPanelWidth=1000 >= 992, so should be true
      expect(result.current.canAddSplitPane).toBe(true);
    });

    it("canAddSplitPane is false when width is insufficient", () => {
      const { result } = setupMaximized([pane1], "p1", null, 400);
      expect(result.current.canAddSplitPane).toBe(false);
    });

    it("canAddSplitPane is false when at MAX_CHAT_PANES", () => {
      const panes: ChatPane[] = Array.from({ length: 6 }, (_, i) => ({
        id: `p${i + 1}`,
        sessionId: `s${i + 1}`,
      }));
      const { result } = setupMaximized(panes, "p1");
      expect(result.current.canAddSplitPane).toBe(false);
    });

    it("focusPaneByIndex focuses the pane at the given index", () => {
      const focusPane = vi.fn();
      const store = useChatStore.getState();
      useChatStore.setState({ ...store, focusPane });
      const { result } = setupMaximized([pane1, pane2], "p1");
      act(() => result.current.focusPaneByIndex(1));
      expect(focusPane).toHaveBeenCalledWith("p2");
    });

    it("focusPaneByIndex returns false for out-of-range index", () => {
      const { result } = setupMaximized([pane1], "p1");
      expect(result.current.focusPaneByIndex(5)).toBe(false);
    });

    it("focusPaneByIndex returns true for valid index", () => {
      const { result } = setupMaximized([pane1], "p1");
      expect(result.current.focusPaneByIndex(0)).toBe(true);
    });

    it("focusPaneByOffset wraps around with modulo", () => {
      const focusPane = vi.fn();
      const store = useChatStore.getState();
      useChatStore.setState({ ...store, focusPane });
      // Start with p1 as the active pane
      const { result } = setupMaximized([pane1, pane2], "p1");
      // Offset +1 from p1 (index 0) → p2 (index 1)
      expect(result.current.focusPaneByOffset(1)).toBe(true);
      expect(focusPane).toHaveBeenLastCalledWith("p2");
    });

    it("focusPaneByOffset computes correct index from different active pane", () => {
      const focusPane = vi.fn();
      const store = useChatStore.getState();
      useChatStore.setState({ ...store, focusPane });
      // Start with p2 as the active pane
      const { result } = setupMaximized([pane1, pane2], "p2");
      // Offset +1 from p2 (index 1) → wraps to p1 (index 0)
      expect(result.current.focusPaneByOffset(1)).toBe(true);
      expect(focusPane).toHaveBeenLastCalledWith("p1");
    });

    it("focusPaneByOffset handles negative offset wrap", () => {
      const focusPane = vi.fn();
      const store = useChatStore.getState();
      useChatStore.setState({ ...store, focusPane });
      const { result } = setupMaximized([pane1, pane2], "p1");
      // Offset -1 from p1 (index 0) → wraps to p2 (index 1)
      expect(result.current.focusPaneByOffset(-1)).toBe(true);
      expect(focusPane).toHaveBeenLastCalledWith("p2");
    });

    it("focusPaneByOffset returns false with single pane", () => {
      const { result } = setupMaximized([pane1], "p1");
      expect(result.current.focusPaneByOffset(1)).toBe(false);
    });

    it("closeActivePane calls closePane with the active pane", () => {
      const closePane = vi.fn();
      const store = useChatStore.getState();
      useChatStore.setState({ ...store, closePane });
      const { result } = setupMaximized([pane1, pane2], "p1");
      expect(result.current.closeActivePane()).toBe(true);
      expect(closePane).toHaveBeenCalledWith("p1");
    });

    it("closeActivePane returns false with single pane", () => {
      const { result } = setupMaximized([pane1], "p1");
      expect(result.current.closeActivePane()).toBe(false);
    });

    it("closeActivePane returns false when not maximized", () => {
      const { result } = renderPaneHook({
        isMaximized: false,
        activeSession: makeSession({ id: "s1" }),
      });
      expect(result.current.closeActivePane()).toBe(false);
    });

    it("keepOnlyActivePane calls unsplitPanes with the active pane id", () => {
      const unsplitPanes = vi.fn();
      const store = useChatStore.getState();
      useChatStore.setState({ ...store, unsplitPanes });
      const { result } = setupMaximized([pane1, pane2], "p1");
      expect(result.current.keepOnlyActivePane()).toBe(true);
      expect(unsplitPanes).toHaveBeenCalledWith("p1");
    });

    it("keepOnlyActivePane returns false with single pane", () => {
      const { result } = setupMaximized([pane1], "p1");
      expect(result.current.keepOnlyActivePane()).toBe(false);
    });
  });
});
