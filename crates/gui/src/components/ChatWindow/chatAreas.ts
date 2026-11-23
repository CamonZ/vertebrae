import type { FocusEvent } from "react";

const COMPOSER_SELECTOR = '[data-testid="local-chat-composer"]';

/**
 * Marks the shown section of a chat's side column (Changes, Discussions or
 * Background tasks) as the stop after the composer in the chat-area row.
 */
export const CHAT_AREA_ATTRIBUTE = "data-chat-area";

/**
 * Focus entering a side section's list from outside (a section switch,
 * ⌘⌥→) lands on its first row, so ↑/↓ move through the list at once.
 */
export function enterFirstRow(
  event: FocusEvent<HTMLElement>,
  rowSelector: string
) {
  const section = event.currentTarget;
  const from = event.relatedTarget;
  if (event.target !== section || (from instanceof Node && section.contains(from)))
    return;
  section.querySelector<HTMLElement>(rowSelector)?.focus({ preventScroll: true });
}

/**
 * The areas ⌘⌥←/→ walks inside one chat: its composer, then its side
 * column's shown section when the column is open (decision 49d12c2c §4).
 */
export function chatAreas(pane: ParentNode): HTMLElement[] {
  const chat =
    pane.querySelector<HTMLElement>(COMPOSER_SELECTOR) ??
    pane.querySelector<HTMLElement>("[tabindex]");
  const side = pane.querySelector<HTMLElement>(`[${CHAT_AREA_ATTRIBUTE}]`);
  return [chat, side].filter((area): area is HTMLElement => !!area);
}

/**
 * Move focus `offset` areas within the active chat (wrapping). It never
 * leaves the chat: moving between chats is ⌃Tab, ⌘⌥N or ⌘⌥J. False when
 * there is nowhere to go.
 */
export function moveChatArea(from: Element | null, offset: -1 | 1): boolean {
  const pane =
    from?.closest("[data-pane-id]") ??
    document.querySelector(".hc-chat-panes [data-pane-id]");
  if (!pane) return false;
  const areas = chatAreas(pane);
  if (areas.length <= 1) return false;
  // Anywhere else in the chat (transcript, header) counts as its chat area.
  const at = !from || !pane.contains(from) ? -1 : areas[1].contains(from) ? 1 : 0;
  const next =
    at < 0
      ? offset === 1
        ? areas[0]
        : areas[1]
      : areas[(at + offset + 2) % 2];
  next.focus({ preventScroll: true });
  return true;
}

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
