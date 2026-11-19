import { useChatStore } from "../../stores/chatStore";

/** Marks a pane's Changes panel as a stop in the chat-area row. */
export const CHAT_AREA_ATTRIBUTE = "data-chat-area";

interface ChatArea {
  paneId: string;
  element: HTMLElement;
}

/**
 * The row ⌘⌥←/→ walks, left to right: each pane's chat (its composer), then
 * that pane's Changes when it is open.
 */
export function chatAreas(root: ParentNode): ChatArea[] {
  return Array.from(root.querySelectorAll<HTMLElement>("[data-pane-id]")).flatMap(
    (pane) => {
      const paneId = pane.dataset.paneId ?? "";
      const chat =
        pane.querySelector<HTMLElement>('[data-testid="local-chat-composer"]') ??
        pane.querySelector<HTMLElement>("[tabindex]") ??
        pane;
      const changes = pane.querySelector<HTMLElement>(
        `[${CHAT_AREA_ATTRIBUTE}="changes"]`
      );
      return [
        { paneId, element: chat },
        ...(changes ? [{ paneId, element: changes }] : []),
      ];
    }
  );
}

/** Index of the area holding `focused`: its Changes, else its pane's chat. */
function currentArea(areas: ChatArea[], focused: Element | null): number {
  if (!focused) return -1;
  const changes = areas.findIndex(
    (area) =>
      area.element.hasAttribute(CHAT_AREA_ATTRIBUTE) &&
      area.element.contains(focused)
  );
  if (changes >= 0) return changes;
  const pane = focused.closest<HTMLElement>("[data-pane-id]")?.dataset.paneId;
  return areas.findIndex((area) => area.paneId === pane);
}

/**
 * Move focus `offset` areas along the row containing `from` (wrapping),
 * activating the destination pane first. False when there is nowhere to go.
 */
export function moveChatArea(from: Element | null, offset: -1 | 1): boolean {
  const root =
    from?.closest(".hc-chat-panes") ?? document.querySelector(".hc-chat-panes");
  if (!root) return false;
  const areas = chatAreas(root);
  if (areas.length <= 1) return false;
  const at = currentArea(areas, from);
  const next =
    areas[
      at < 0
        ? offset === 1
          ? 0
          : areas.length - 1
        : (at + offset + areas.length) % areas.length
    ];
  const store = useChatStore.getState();
  if (store.paneLayout.activePaneId !== next.paneId) {
    store.focusPane(next.paneId);
    // Activating a pane focuses its composer; take focus after that settles.
    requestAnimationFrame(() => next.element.focus({ preventScroll: true }));
  } else {
    next.element.focus({ preventScroll: true });
  }
  return true;
}

const COMPOSER_SELECTOR = '[data-testid="local-chat-composer"]';
const TRANSCRIPT_SELECTOR = "[data-transcript-viewport]";

/** Focus the composer of the pane holding `from`. */
export function focusPaneComposer(from: Element | null): boolean {
  const composer = from
    ?.closest("[data-pane-id]")
    ?.querySelector<HTMLElement>(COMPOSER_SELECTOR);
  if (!composer) return false;
  composer.focus({ preventScroll: true });
  return document.activeElement === composer;
}

const PENDING_COMMENT_SELECTOR = ".chat-comment-chip";

function paneOf(from: Element | null): Element | null {
  return from?.closest("[data-pane-id]") ?? null;
}

/** ⌘⌥↑ from the composer or its comments: the pane's transcript caret. */
export function focusPaneTranscript(from: Element | null): boolean {
  const transcript =
    paneOf(from)?.querySelector<HTMLElement>(TRANSCRIPT_SELECTOR);
  if (!transcript) return false;
  // Focused by the mouse: refocus so the caret starts.
  if (document.activeElement === transcript) transcript.blur();
  transcript.focus({ preventScroll: true });
  return document.activeElement === transcript;
}

/** ⌘⌥↓ from the transcript: the pending comments, else the composer. */
export function focusBelowTranscript(from: Element | null): boolean {
  const pane = paneOf(from);
  const chip =
    pane?.querySelector<HTMLElement>(
      `${PENDING_COMMENT_SELECTOR}[tabindex="0"]`
    ) ?? null;
  if (!chip) return focusPaneComposer(from);
  chip.focus({ preventScroll: true });
  return document.activeElement === chip;
}
