export type ChatShortcutModifier = "meta" | "shift";

export interface ChatShortcutDefinition {
  readonly modifiers: readonly ChatShortcutModifier[];
  readonly keys: readonly string[];
  readonly displayKey: string;
  readonly label: string;
}

/**
 * The chat-help binding is shared by the event handler and every UI hint.
 * `?` and `/` are both accepted because the shifted slash key reports either
 * value depending on the keyboard layout and browser.
 */
export const CHAT_HELP_SHORTCUT = {
  modifiers: ["meta", "shift"],
  keys: ["?", "/"],
  displayKey: "/",
  label: "Show keyboard shortcuts",
} as const satisfies ChatShortcutDefinition;

type ShortcutEvent = Pick<KeyboardEvent, "metaKey" | "shiftKey" | "key">;

export function matchesChatShortcut(
  event: ShortcutEvent,
  shortcut: ChatShortcutDefinition
): boolean {
  const modifierState: Record<ChatShortcutModifier, boolean> = {
    meta: event.metaKey,
    shift: event.shiftKey,
  };
  return (
    shortcut.modifiers.every((modifier) => modifierState[modifier]) &&
    shortcut.keys.includes(event.key)
  );
}

function isApplePlatform(platform: string): boolean {
  return /Mac|iPhone|iPad|iPod/.test(platform);
}

function currentPlatform(): string {
  return typeof navigator === "undefined" ? "" : navigator.platform;
}

function accessibleKeyName(key: string): string {
  if (key === "/") return "slash";
  if (key === "?") return "question mark";
  return key;
}

export interface ChatShortcutPresentation {
  keys: readonly string[];
  ariaLabel: string;
}

export function presentChatShortcut(
  shortcut: ChatShortcutDefinition | null | undefined,
  platform = currentPlatform()
): ChatShortcutPresentation | null {
  if (!shortcut || shortcut.modifiers.length === 0 || !shortcut.displayKey) {
    return null;
  }

  const apple = isApplePlatform(platform);
  const keys: string[] = shortcut.modifiers.map((modifier) => {
    if (modifier === "meta") return apple ? "⌘" : "Meta";
    return apple ? "⇧" : "Shift";
  });
  keys.push(shortcut.displayKey);

  const accessibleModifiers = shortcut.modifiers.map((modifier) => {
    if (modifier === "meta") return apple ? "Command" : "Meta";
    return "Shift";
  });
  return {
    keys,
    ariaLabel: [
      ...accessibleModifiers,
      accessibleKeyName(shortcut.displayKey),
    ].join(" "),
  };
}

export const CHANGES_FOCUS_SHORTCUT = {
  modifiers: ["meta", "shift"],
  keys: ["J", "j"],
  displayKey: "J",
  label: "Focus Changes / composer",
} as const satisfies ChatShortcutDefinition;

export const CHANGES_KEYS = {
  base: { key: "b", label: "Base" },
  target: { key: "h", label: "Compare" },
  files: { key: "l", label: "File list" },
  previous: { key: "p", label: "Previous file" },
  next: { key: "n", label: "Next file" },
  diff: { key: "d", label: "Full diff" },
  file: { key: "f", label: "Full file" },
  external: { key: "e", label: "External editor" },
} as const;

export const CHANGED_FILE_LIST_KEYS = {
  keys: ["↑", "↓"],
  label: "Browse file list",
  directions: { ArrowUp: -1, ArrowDown: 1 },
} as const;

export const COMPARISON_KEYS = [
  { keys: ["Type", "⌫"], label: "Filter options" },
  { keys: ["↑", "↓", "Home", "End"], label: "Navigate options" },
  { keys: ["↵"], label: "Select option" },
  { keys: ["Esc"], label: "Close picker" },
];
