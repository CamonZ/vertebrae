import { useChatSideColumnStore } from "./chatSideColumnStore";

/**
 * Per-chat view state that outlives a hidden tab or pane (ticket 736f94f3):
 * hidden chats unmount, so returning restores the transcript position and
 * the area that had focus from here. Runtime only; drafts live in
 * composerDraftStore.
 */
type ChatScrollPosition =
  | { kind: "tail" }
  /** The first visible event and its offset from the viewport top. */
  | { kind: "anchor"; id: string; offset: number };

const positions = new Map<string, ChatScrollPosition>();

export function saveChatScroll(
  sessionId: string,
  viewport: HTMLElement,
  following: boolean,
  anchors: ReadonlyMap<string, HTMLElement>
) {
  if (following) {
    positions.set(sessionId, { kind: "tail" });
    return;
  }
  const top = viewport.getBoundingClientRect().top;
  let best: { id: string; offset: number } | null = null;
  for (const [id, element] of anchors) {
    if (!element.isConnected) continue;
    const rect = element.getBoundingClientRect();
    if (rect.bottom <= top) continue;
    const offset = rect.top - top;
    if (!best || offset < best.offset) best = { id, offset };
  }
  if (best) positions.set(sessionId, { kind: "anchor", ...best });
  else positions.set(sessionId, { kind: "tail" });
}

/**
 * Restores a saved position. Returns false for the live tail (or nothing
 * saved), leaving bottom-follow in charge.
 */
export function restoreChatScroll(
  sessionId: string,
  viewport: HTMLElement,
  anchors: ReadonlyMap<string, HTMLElement>
): boolean {
  const saved = positions.get(sessionId);
  if (!saved || saved.kind === "tail") return false;
  const element = anchors.get(saved.id);
  if (!element) return false;
  viewport.scrollTop +=
    element.getBoundingClientRect().top -
    viewport.getBoundingClientRect().top -
    saved.offset;
  return true;
}

/** The chat areas focus can return to. */
/** `side`: the chat's side column (its shown section). */
export type ChatFocusArea = "composer" | "transcript" | "side";

const focusAreas = new Map<string, ChatFocusArea>();

/** The area holding `target` inside a chat pane, if any. */
export function chatFocusAreaOf(target: Element): ChatFocusArea | null {
  if (target.closest("[data-chat-area]")) return "side";
  if (target.closest("[data-transcript-viewport]")) return "transcript";
  if (target.closest('[data-testid="local-chat-composer"]')) return "composer";
  return null;
}

export function saveChatFocusArea(sessionId: string, area: ChatFocusArea) {
  focusAreas.set(sessionId, area);
}

/** The area to focus when the chat is shown again; the composer by default. */
export function chatFocusArea(sessionId: string): ChatFocusArea {
  return focusAreas.get(sessionId) ?? "composer";
}

export function forgetChatView(sessionId?: string) {
  useChatSideColumnStore.getState().forget(sessionId);
  if (sessionId === undefined) {
    positions.clear();
    focusAreas.clear();
  } else {
    positions.delete(sessionId);
    focusAreas.delete(sessionId);
  }
}
