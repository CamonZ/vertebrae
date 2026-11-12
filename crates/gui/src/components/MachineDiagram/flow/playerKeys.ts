/** Keyboard shortcuts of the flow player, as a pure key → command map. */

export type PlayerCommand =
  | { readonly kind: "toggle" }
  | { readonly kind: "step"; readonly dir: 1 | -1 }
  | { readonly kind: "frame"; readonly dir: 1 | -1 }
  /** Beat index; -1 means the last beat. */
  | { readonly kind: "seek"; readonly beat: number }
  | { readonly kind: "speed"; readonly dir: 1 | -1 }
  | { readonly kind: "loop" }
  | { readonly kind: "arrangement" }
  | { readonly kind: "beats" }
  | { readonly kind: "clear" }
  | { readonly kind: "help" };

export interface KeyMods {
  readonly shiftKey?: boolean;
  readonly altKey?: boolean;
  readonly ctrlKey?: boolean;
  readonly metaKey?: boolean;
}

/** Shortcut list shown by the player's help (same order as the controls). */
export const PLAYER_SHORTCUTS: readonly (readonly [
  keys: string,
  what: string,
])[] = [
  ["Space / K", "play or pause"],
  ["← / →", "previous / next beat"],
  [", / .  or  ⇧← / ⇧→", "previous / next frame"],
  ["1 – 9, Home, End", "jump to a beat"],
  ["− / +", "slower / faster"],
  ["L", "loop, or play once and stop at the end"],
  ["B", "Before / After"],
  ["C", "show or hide the beats"],
  ["Tab, Enter", "focus and open a part or follow a card"],
  ["Esc", "stop following, unpin"],
  ["?", "show or hide these keys"],
];

/** The command for a key press, or null when the player ignores it. */
export function playerCommand(
  key: string,
  m: KeyMods = {}
): PlayerCommand | null {
  // Leave app and system shortcuts alone.
  if (m.ctrlKey || m.metaKey || m.altKey) return null;
  switch (key) {
    case " ":
    case "Spacebar":
    case "k":
    case "K":
      return { kind: "toggle" };
    case "ArrowRight":
      return m.shiftKey ? { kind: "frame", dir: 1 } : { kind: "step", dir: 1 };
    case "ArrowLeft":
      return m.shiftKey
        ? { kind: "frame", dir: -1 }
        : { kind: "step", dir: -1 };
    case ".":
      return { kind: "frame", dir: 1 };
    case ",":
      return { kind: "frame", dir: -1 };
    case "Home":
      return { kind: "seek", beat: 0 };
    case "End":
      return { kind: "seek", beat: -1 };
    case "+":
    case "=":
      return { kind: "speed", dir: 1 };
    case "-":
    case "_":
      return { kind: "speed", dir: -1 };
    case "b":
    case "B":
      return { kind: "arrangement" };
    case "c":
    case "C":
      return { kind: "beats" };
    case "l":
    case "L":
      return { kind: "loop" };
    case "Escape":
      return { kind: "clear" };
    case "?":
      return { kind: "help" };
    default:
      return /^[1-9]$/.test(key)
        ? { kind: "seek", beat: Number(key) - 1 }
        : null;
  }
}

/**
 * Whether a command should be left to the focused element: text fields keep
 * every key; buttons, parts and cards keep Space/Enter; radio groups keep
 * arrows and Home/End.
 */
export function leaveToTarget(
  target: EventTarget | null,
  root: Element,
  key: string
): boolean {
  if (!(target instanceof Element) || target === root) return false;
  if (
    target.closest("input, textarea, select, [contenteditable='true']") !== null
  )
    return true;
  const activation = key === " " || key === "Spacebar" || key === "Enter";
  if (
    activation &&
    target.closest(
      "button, summary, a[href], [role='button'], [role='radio']"
    ) !== null
  )
    return true;
  const nav = key.startsWith("Arrow") || key === "Home" || key === "End";
  return nav && target.closest("[role='radiogroup']") !== null;
}
