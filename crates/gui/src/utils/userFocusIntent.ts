/**
 * Tracks the last user action that can legitimately move keyboard focus: a
 * pointer press, Tab, Escape, F6 or a modified key (shortcuts). Plain typing,
 * Enter and caret keys never move focus out of a text input.
 *
 * Listeners are shared and reference-counted: each `retainUserFocusIntent`
 * caller releases its hold, and the last release removes them.
 */

/** How long a user action keeps explaining focus moves that follow it. */
export const USER_FOCUS_INTENT_MS = 500;

let lastActionAt = Number.NEGATIVE_INFINITY;
let holders = 0;

export function isFocusMovingKey(event: KeyboardEvent): boolean {
  return (
    event.key === "Tab" ||
    event.key === "Escape" ||
    event.key === "F6" ||
    event.metaKey ||
    event.ctrlKey ||
    event.altKey
  );
}

function onPointerDown() {
  lastActionAt = performance.now();
}

function onKeyDown(event: KeyboardEvent) {
  if (isFocusMovingKey(event)) lastActionAt = performance.now();
}

export function retainUserFocusIntent(): () => void {
  if (holders++ === 0) {
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("mousedown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
  }
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--holders > 0) return;
    window.removeEventListener("pointerdown", onPointerDown, true);
    window.removeEventListener("mousedown", onPointerDown, true);
    window.removeEventListener("keydown", onKeyDown, true);
    lastActionAt = Number.NEGATIVE_INFINITY;
  };
}

/** Whether a focus-moving user action happened within the intent window. */
export function userMovedFocusRecently(): boolean {
  return performance.now() - lastActionAt < USER_FOCUS_INTENT_MS;
}
