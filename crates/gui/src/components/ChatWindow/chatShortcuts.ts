export type ChatShortcutModifier = "meta" | "shift";

export interface ChatShortcutDefinition {
  readonly modifiers: readonly ChatShortcutModifier[];
  /** KeyboardEvent.key values accepted by the binding. */
  readonly keys: readonly string[];
  /** The key shown to users for this shortcut. */
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

/**
 * Formats a shortcut for both visual and assistive-technology consumers.
 * Passing no definition represents unavailable shortcut metadata.
 */
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
