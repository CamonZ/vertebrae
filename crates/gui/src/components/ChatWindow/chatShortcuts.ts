export type ChatShortcutModifier = "meta" | "alt" | "shift";

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

type ShortcutEvent = Pick<KeyboardEvent, "metaKey" | "shiftKey" | "key"> &
  Partial<Pick<KeyboardEvent, "altKey">>;

export function matchesChatShortcut(
  event: ShortcutEvent,
  shortcut: ChatShortcutDefinition
): boolean {
  const modifierState: Record<ChatShortcutModifier, boolean> = {
    meta: event.metaKey,
    alt: event.altKey ?? false,
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
    if (modifier === "alt") return apple ? "⌥" : "Alt";
    return apple ? "⇧" : "Shift";
  });
  keys.push(shortcut.displayKey);

  const accessibleModifiers = shortcut.modifiers.map((modifier) => {
    if (modifier === "meta") return apple ? "Command" : "Meta";
    if (modifier === "alt") return apple ? "Option" : "Alt";
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

/**
 * Moves focus along the row of chat areas: chat 1 · its Changes · chat 2 ·
 * its Changes … wrapping at the ends.
 */
export const CHAT_AREA_SHORTCUT = {
  modifiers: ["meta", "alt"],
  keys: ["ArrowLeft", "ArrowRight"],
  displayKey: "← / →",
  label: "Move between chats and Changes",
} as const satisfies ChatShortcutDefinition;

/** Changes actions that live in the ⌘K palette rather than on single keys. */
export const CHANGES_COMMANDS = {
  base: "Choose base",
  target: "Choose compare target",
  files: "Show file list",
  diff: "Open full diff",
  file: "Open full file",
  external: "Open in external editor",
  unified: "Unified diff",
  split: "Split diff",
  refresh: "Refresh changes",
} as const;

/** Toggle a file's viewed mark (folds it; the cursor skips it). */
export const CHANGES_VIEWED_KEY = "v";

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

/** Copy the diff line selection as plain code. */
export const DIFF_COPY_SHORTCUT = {
  modifiers: ["meta"],
  keys: ["c", "C"],
  displayKey: "C",
  label: "Copy selected code",
} as const satisfies ChatShortcutDefinition;

/** Diff composer: create the inline discussion (or comment) for the range. */
export const DIFF_COMPOSER_SUBMIT_SHORTCUT = {
  modifiers: ["meta"],
  keys: ["Enter"],
  displayKey: "↵",
  label: "Create inline discussion",
} as const satisfies ChatShortcutDefinition;

/** Diff composer: send the selection and text to the main chat. */
export const DIFF_COMPOSER_SEND_SHORTCUT = {
  modifiers: ["meta", "shift"],
  keys: ["Enter"],
  displayKey: "↵",
  label: "Send to main chat",
} as const satisfies ChatShortcutDefinition;

/** Keys that open the composer for the keyboard line selection. */
export const DIFF_COMMENT_KEYS = ["c", "Enter"] as const;

/** Display string for a modifier shortcut, e.g. `⌘⇧↵`. */
export function shortcutText(shortcut: ChatShortcutDefinition): string {
  return presentChatShortcut(shortcut)?.keys.join("") ?? "";
}

/** Where focus is relative to a Changes panel; hints are listed per situation. */
export type ChangesSituation =
  | "outside"
  | "panel"
  | "files"
  | "picker"
  | "diff"
  | "composer";

export interface KeyHint {
  keys: readonly string[];
  label: string;
  /** A file-jump hint the footer renders as a button. */
  move?: -1 | 1;
  /** Only meaningful in a split diff. */
  splitOnly?: boolean;
}

const modifierKeys = (shortcut: ChatShortcutDefinition) =>
  presentChatShortcut(shortcut)?.keys ?? [];

const AREA_HINT: KeyHint = {
  keys: modifierKeys(CHAT_AREA_SHORTCUT),
  label: CHAT_AREA_SHORTCUT.label,
};
const FILE_JUMP_HINTS: KeyHint[] = [
  { keys: ["⌥", "⇧", "↑"], label: "Previous file", move: -1 },
  { keys: ["⌥", "⇧", "↓"], label: "Next file", move: 1 },
];
const PALETTE_HINTS: KeyHint[] = [
  { keys: ["/"], label: "Find file" },
  { keys: ["⌘", "K"], label: "Changes commands" },
];
const RESIZE_HINTS: KeyHint[] = [
  { keys: ["⌥", "← / →"], label: "Resize panel" },
  { keys: ["⌥", "="], label: "Cycle panel width" },
];

/**
 * Every Changes binding, grouped by the situation it applies to. The key-hint
 * footer shows the group for the current focus; the ⌘⇧/ overlay lists them all.
 */
export const CHANGES_HINT_GROUPS: readonly {
  situation: Exclude<ChangesSituation, "outside">;
  title: string;
  hints: readonly KeyHint[];
}[] = [
  {
    situation: "panel",
    title: "Changes",
    hints: [
      AREA_HINT,
      ...FILE_JUMP_HINTS,
      ...PALETTE_HINTS,
      { keys: ["↓"], label: "Line cursor (from a file heading)" },
      { keys: [CHANGES_VIEWED_KEY], label: "Mark file viewed" },
      ...RESIZE_HINTS,
    ],
  },
  {
    situation: "files",
    title: "Changes · file list",
    hints: [
      { keys: CHANGED_FILE_LIST_KEYS.keys, label: CHANGED_FILE_LIST_KEYS.label },
      { keys: ["↵"], label: "Show file" },
      ...FILE_JUMP_HINTS,
      ...PALETTE_HINTS,
    ],
  },
  {
    situation: "picker",
    title: "Changes · base and compare pickers",
    hints: COMPARISON_KEYS,
  },
  {
    situation: "diff",
    title: "Changes · line cursor",
    hints: [
      { keys: ["↑", "↓"], label: "Move line cursor" },
      { keys: ["⇧", "↑ / ↓"], label: "Extend selection" },
      { keys: ["⌥", "↑ / ↓"], label: "Previous / next hunk or comment" },
      ...FILE_JUMP_HINTS,
      { keys: ["←", "→"], label: "Switch side", splitOnly: true },
      { keys: ["← / →"], label: "Past the edge: chat / next area" },
      { keys: modifierKeys(DIFF_COPY_SHORTCUT), label: DIFF_COPY_SHORTCUT.label },
      { keys: ["c / ↵"], label: "Discuss selection" },
      { keys: [CHANGES_VIEWED_KEY], label: "Mark file viewed, go to next" },
      ...PALETTE_HINTS,
      { keys: ["Esc"], label: "Single line / back to chat" },
    ],
  },
  {
    situation: "composer",
    title: "Changes · comment box",
    hints: [
      {
        keys: modifierKeys(DIFF_COMPOSER_SUBMIT_SHORTCUT),
        label: DIFF_COMPOSER_SUBMIT_SHORTCUT.label,
      },
      {
        keys: modifierKeys(DIFF_COMPOSER_SEND_SHORTCUT),
        label: DIFF_COMPOSER_SEND_SHORTCUT.label,
      },
      { keys: ["Esc"], label: "Cancel and return to line" },
    ],
  },
];

/** The footer's hints for one situation; ⌘⇧/ always closes the list. */
export function changesHintsFor(
  situation: ChangesSituation,
  options: { split: boolean }
): KeyHint[] {
  const group = CHANGES_HINT_GROUPS.find((entry) => entry.situation === situation);
  const hints = (group?.hints ?? [AREA_HINT]).filter(
    (hint) => options.split || !hint.splitOnly
  );
  return [...hints, { keys: modifierKeys(CHAT_HELP_SHORTCUT), label: "All shortcuts" }];
}
