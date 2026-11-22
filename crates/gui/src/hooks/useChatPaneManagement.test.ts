import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useChatPaneManagement } from "./useChatPaneManagement";
import {
  chatsNeedingYou,
  useChatTabs,
} from "../components/ChatWindow/useChatTabs";
import { useChatStore, type ChatSession } from "../stores/chatStore";
import {
  EMPTY_WORKSPACE,
  type ChatPane,
  type ChatWorkspaceLayout,
} from "../stores/chatWorkspace";

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

const pane1: ChatPane = { id: "p1", sessionId: "s1" };
const pane2: ChatPane = { id: "p2", sessionId: "s2" };
const pane3: ChatPane = { id: "p3", sessionId: "s3" };

function seed(
  order: ChatPane[],
  layout: Partial<ChatWorkspaceLayout> = {},
  extraSessions: ChatSession[] = []
) {
  const sessions: Record<string, ChatSession> = {};
  for (const pane of order) {
    if ("sessionId" in pane && pane.sessionId) {
      sessions[pane.sessionId] = makeSession({
        id: pane.sessionId,
        label: pane.sessionId,
      });
    }
  }
  for (const session of extraSessions) sessions[session.id] = session;
  useChatStore.setState({
    sessions,
    activeSessionId:
      order[0] && "sessionId" in order[0] ? order[0].sessionId : null,
    paneLayout: {
      ...EMPTY_WORKSPACE,
      order,
      activeId: order[0]?.id ?? null,
      ...layout,
    },
  });
}

/** Composes the hook with the strip's needing-you list, as the manager does. */
function renderPaneHook() {
  return renderHook(() => {
    const order = useChatStore((state) => state.paneLayout.order);
    const tabs = useChatTabs(order, undefined);
    return useChatPaneManagement({ needingYou: chatsNeedingYou(tabs) });
  });
}

const layout = () => useChatStore.getState().paneLayout;

describe("useChatPaneManagement", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {},
      activeSessionId: null,
      paneLayout: EMPTY_WORKSPACE,
      panelOpen: true,
    });
  });

  describe("shown chat", () => {
    it("shows nothing before any chat opens", () => {
      const { result } = renderPaneHook();
      expect(result.current.shownPane).toBeNull();
    });

    it("shows only the active chat", () => {
      seed([pane1, pane2, pane3], { activeId: "p2" });
      const { result } = renderPaneHook();
      expect(result.current.shownPane?.id).toBe("p2");
    });

    it("falls back to the first chat without an active id", () => {
      seed([pane1, pane2], { activeId: null });
      const { result } = renderPaneHook();
      expect(result.current.shownPane?.id).toBe("p1");
    });
  });

  describe("actions", () => {
    it("focusPaneByIndex activates chat N and asks for its composer", () => {
      seed([pane1, pane2, pane3]);
      const { result } = renderPaneHook();
      const revision = useChatStore.getState().composerFocusRevision;
      act(() => {
        expect(result.current.focusPaneByIndex(1)).toBe(true);
      });
      expect(layout().activeId).toBe("p2");
      expect(useChatStore.getState().composerFocusRevision).toBe(revision + 1);
    });

    it("focusPaneByIndex(8) is the last chat however many are open", () => {
      seed([pane1, pane2, pane3]);
      const { result } = renderPaneHook();
      act(() => {
        result.current.focusPaneByIndex(8);
      });
      expect(layout().activeId).toBe("p3");
    });

    it("focusPaneByIndex returns false for an index past the open chats", () => {
      seed([pane1]);
      const { result } = renderPaneHook();
      expect(result.current.focusPaneByIndex(5)).toBe(false);
    });

    it.each([
      ["p1", 1, "p2"],
      ["p2", 1, "p1"],
      ["p1", -1, "p2"],
    ])("focusPaneByOffset from %s by %i wraps to %s", (from, offset, to) => {
      seed([pane1, pane2], { activeId: from });
      const { result } = renderPaneHook();
      act(() => {
        expect(result.current.focusPaneByOffset(offset)).toBe(true);
      });
      expect(layout().activeId).toBe(to);
    });

    it("focusPaneByOffset returns false with a single chat", () => {
      seed([pane1]);
      const { result } = renderPaneHook();
      expect(result.current.focusPaneByOffset(1)).toBe(false);
    });

    it("focusNeedingYou cycles through chats needing the user", () => {
      seed([pane1, pane2, pane3], {}, [
        makeSession({ id: "s2", label: "s2", lifecycle: "error" }),
        makeSession({ id: "s3", label: "s3", lifecycle: "error" }),
      ]);
      const { result, rerender } = renderPaneHook();
      act(() => {
        expect(result.current.focusNeedingYou(1)).toBe(true);
      });
      const first = layout().activeId;
      expect(["p2", "p3"]).toContain(first);
      rerender();
      act(() => {
        result.current.focusNeedingYou(1);
      });
      expect(layout().activeId).not.toBe(first);
      expect(["p2", "p3"]).toContain(layout().activeId);
    });

    it("focusNeedingYou returns false when no chat needs the user", () => {
      seed([pane1, pane2]);
      const { result } = renderPaneHook();
      expect(result.current.focusNeedingYou(1)).toBe(false);
    });

    it("closeActivePane closes the active chat", () => {
      seed([pane1, pane2], { activeId: "p1" });
      const { result } = renderPaneHook();
      act(() => {
        expect(result.current.closeActivePane()).toBe(true);
      });
      expect(layout().order.map((pane) => pane.id)).toEqual(["p2"]);
    });

    it("closeActivePane keeps the last open chat", () => {
      seed([pane1]);
      const { result } = renderPaneHook();
      expect(result.current.closeActivePane()).toBe(false);
      expect(layout().order).toHaveLength(1);
    });

    it("moveActivePane moves the active chat in strip order", () => {
      seed([pane1, pane2, pane3], { activeId: "p1" });
      const { result } = renderPaneHook();
      act(() => {
        expect(result.current.moveActivePane(1)).toBe(true);
      });
      expect(layout().order.map((pane) => pane.id)).toEqual(["p2", "p1", "p3"]);
    });
  });
});
