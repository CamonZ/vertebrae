import type { KeyboardEvent } from "react";
import { isEditableShortcutTarget } from "../../../utils/keyboard";
import { DIFF_CURSOR_HOST_ATTRIBUTE } from "../../thread/toolChange/diffCursor";
import {
  CHANGED_FILE_LIST_KEYS,
  CHANGES_REVIEW_KEY,
  CHANGES_THREAD_STEP_CODES,
  CHANGES_VIEWED_KEY,
} from "../chatShortcuts";

/** What Changes' keys do. */
export interface ChangesKeyActions {
  /** A dialog (unsaved changes) owns the keys. */
  blocked: boolean;
  /** ⌘S: save the active document, when one is editable. */
  save(): void;
  /** /: find a file in the palette. */
  findFile(origin: HTMLElement): void;
  moveFile(direction: -1 | 1): void;
  unviewLast(): void;
  fileList: HTMLElement | null;
  /** v: toggle the active file's viewed mark; null without a file. */
  toggleViewed: (() => void) | null;
  /** r: open or close the Review rail; null without a linked PR. */
  toggleReview: (() => void) | null;
  /** [ and ]: the previous or next GitHub thread, from the focused one. */
  stepThread: ((origin: HTMLElement, direction: -1 | 1) => void) | null;
}

/**
 * Changes' keys, handled in the capture phase so they beat the diff and
 * editors: ⌘S, / to find a file, ⌥⇧↑/↓ between file headings, ⇧V to
 * unmark the last viewed file, ↑/↓ in the file list, v to mark viewed,
 * r for the Review rail, [ and ] between GitHub threads.
 */
export function handleChangesKeyDown(
  event: KeyboardEvent<HTMLElement>,
  actions: ChangesKeyActions
) {
  if (
    !actions.blocked &&
    (event.metaKey || event.ctrlKey) &&
    !event.altKey &&
    event.key.toLowerCase() === "s"
  ) {
    event.preventDefault();
    actions.save();
    return;
  }
  const origin = event.nativeEvent.composedPath()[0];
  if (
    actions.blocked ||
    event.defaultPrevented ||
    event.nativeEvent.isComposing ||
    !(origin instanceof HTMLElement) ||
    !event.currentTarget.contains(origin) ||
    origin.closest('[role="combobox"][aria-expanded="true"]') ||
    document.querySelector('[role="dialog"][aria-modal="true"]')
  )
    return;
  const typing = isEditableShortcutTarget(origin);
  const handled = (run: () => void) => {
    event.preventDefault();
    event.stopPropagation();
    if (!event.repeat) run();
  };

  // / outside text fields: the palette with the changed files first.
  if (
    event.key === "/" &&
    !typing &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    handled(() => actions.findFile(origin));
    return;
  }
  if (typing) return;

  const inDiffCursor = !!origin.closest(`[${DIFF_CURSOR_HOST_ATTRIBUTE}=""]`);
  const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
  // ⌥⇧↑/↓ outside the diff: previous/next file heading. The diff's own
  // headings and lines move the line cursor instead.
  if (
    vertical &&
    event.altKey &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !inDiffCursor
  ) {
    event.preventDefault();
    event.stopPropagation();
    actions.moveFile(event.key === "ArrowDown" ? 1 : -1);
    return;
  }
  // ⇧V anywhere in Changes, the diff included: unmark the last viewed file.
  if (
    event.key.toLowerCase() === CHANGES_VIEWED_KEY &&
    event.shiftKey &&
    !event.metaKey &&
    !event.ctrlKey &&
    !event.altKey
  ) {
    handled(actions.unviewLast);
    return;
  }
  if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;

  const step = CHANGES_THREAD_STEP_CODES[event.code];
  if (step && actions.stepThread) {
    const { stepThread } = actions;
    handled(() => stepThread(origin, step));
    return;
  }
  if (event.key === CHANGES_REVIEW_KEY && actions.toggleReview) {
    handled(actions.toggleReview);
    return;
  }

  const list = actions.fileList;
  if (list?.contains(origin) && vertical) {
    event.preventDefault();
    event.stopPropagation();
    const rows = Array.from(list.querySelectorAll("button"));
    const index = rows.findIndex((row) => row.contains(origin));
    rows[
      index +
        CHANGED_FILE_LIST_KEYS.directions[event.key as "ArrowUp" | "ArrowDown"]
    ]?.focus();
    return;
  }

  // v outside the diff marks the active file; the diff handles its own.
  if (event.key === CHANGES_VIEWED_KEY && !inDiffCursor && actions.toggleViewed)
    handled(actions.toggleViewed);
}
