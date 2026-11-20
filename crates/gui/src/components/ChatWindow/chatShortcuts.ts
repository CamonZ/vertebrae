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
  hideFiles: "Hide file list",
  diff: "Open full diff",
  file: "Open full file",
  external: "Open in external editor",
  unified: "Unified diff",
  split: "Split diff",
  semantic: "Semantic diff",
  line: "Line diff",
  refresh: "Refresh changes",
} as const;

/** Switch this pane's Changes between the semantic and the line diff. */
export const CHANGES_DIFF_MODE_KEY = "m";

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

/** Line cursor on a discussion's anchor: open it and focus its composer. */
export const DISCUSSION_OPEN_KEY = "o";

/** Discussion composer: ask the follow-up inline. */
export const DISCUSSION_ASK_SHORTCUT = {
  modifiers: ["meta"],
  keys: ["Enter"],
  displayKey: "↵",
  label: "Ask follow-up",
} as const satisfies ChatShortcutDefinition;

/** Discussion composer: send the selection and follow-up to the main chat. */
export const DISCUSSION_SEND_SHORTCUT = {
  modifiers: ["meta", "shift"],
  keys: ["Enter"],
  displayKey: "↵",
  label: "Send follow-up to main chat",
} as const satisfies ChatShortcutDefinition;

/** Show only the latest response of a discussion, or every turn again. */
export const DISCUSSION_COLLAPSE_SHORTCUT = {
  modifiers: ["meta", "shift"],
  keys: ["e", "E"],
  displayKey: "E",
  label: "Collapse or expand earlier turns",
} as const satisfies ChatShortcutDefinition;

/** Display string for a modifier shortcut, e.g. `⌘⇧↵`. */
export function shortcutText(shortcut: ChatShortcutDefinition): string {
  return presentChatShortcut(shortcut)?.keys.join("") ?? "";
}

export interface KeyHint {
  keys: readonly string[];
  label: string;
  /** Only meaningful in a split diff. */
  splitOnly?: boolean;
}

/** ⇧V: unmark the file most recently marked viewed and return to it. */
export const CHANGES_UNVIEW_HINT: KeyHint = {
  keys: ["⇧", "V"],
  label: "Unmark last viewed file",
};

const modifierKeys = (shortcut: ChatShortcutDefinition) =>
  presentChatShortcut(shortcut)?.keys ?? [];

const AREA_HINT: KeyHint = {
  keys: modifierKeys(CHAT_AREA_SHORTCUT),
  label: CHAT_AREA_SHORTCUT.label,
};
const FILE_JUMP_HINTS: KeyHint[] = [
  { keys: ["⌥", "⇧", "↑"], label: "Previous file" },
  { keys: ["⌥", "⇧", "↓"], label: "Next file" },
];
const PALETTE_HINTS: KeyHint[] = [
  { keys: ["/"], label: "Find file" },
  { keys: ["⌘", "K"], label: "Changes commands" },
];
const DIFF_MODE_HINT: KeyHint = {
  keys: [CHANGES_DIFF_MODE_KEY],
  label: "Semantic / line diff",
};
const RESIZE_HINTS: KeyHint[] = [
  { keys: ["⌥", "← / →"], label: "Resize panel" },
  { keys: ["⌥", "="], label: "Cycle panel width" },
];

/**
 * Every Changes binding, grouped by where focus is when it applies, for the
 * ⌘⇧/ overlay. Actions without a single key are in the ⌘K palette.
 */
export const CHANGES_HINT_GROUPS: readonly {
  title: string;
  hints: readonly KeyHint[];
}[] = [
  {
    title: "Changes",
    hints: [
      AREA_HINT,
      ...FILE_JUMP_HINTS,
      ...PALETTE_HINTS,
      { keys: ["↓"], label: "Line cursor (from a file heading)" },
      { keys: [CHANGES_VIEWED_KEY], label: "Mark file viewed" },
      CHANGES_UNVIEW_HINT,
      DIFF_MODE_HINT,
      ...RESIZE_HINTS,
    ],
  },
  {
    title: "Changes · file list",
    hints: [
      { keys: CHANGED_FILE_LIST_KEYS.keys, label: CHANGED_FILE_LIST_KEYS.label },
      { keys: ["↵"], label: "Show file" },
      ...FILE_JUMP_HINTS,
      ...PALETTE_HINTS,
    ],
  },
  {
    title: "Changes · base and compare pickers",
    hints: COMPARISON_KEYS,
  },
  {
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
      { keys: [DISCUSSION_OPEN_KEY], label: "Open discussion at line" },
      {
        keys: modifierKeys(DISCUSSION_COLLAPSE_SHORTCUT),
        label: "Collapse or expand the discussion at line",
      },
      { keys: [CHANGES_VIEWED_KEY], label: "Mark file viewed, go to next" },
      CHANGES_UNVIEW_HINT,
      DIFF_MODE_HINT,
      ...PALETTE_HINTS,
      { keys: ["Esc"], label: "Single line / back to chat" },
    ],
  },
  {
    title: "Changes · unchanged lines",
    hints: [
      { keys: ["↑", "↓"], label: "Move line cursor" },
      { keys: ["↵"], label: "Expand toward where you came from" },
      { keys: ["⌥", "↵"], label: "Expand the other way" },
      { keys: ["⌥", "↑ / ↓"], label: "Previous / next hunk or comment" },
      ...FILE_JUMP_HINTS,
      { keys: [CHANGES_VIEWED_KEY], label: "Mark file viewed, go to next" },
      CHANGES_UNVIEW_HINT,
      { keys: ["Esc"], label: "Back to chat" },
    ],
  },
  {
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
  {
    title: "Changes · inline discussion",
    hints: [
      { keys: ["↵"], label: "Open discussion (on its marker)" },
      {
        keys: modifierKeys(DISCUSSION_ASK_SHORTCUT),
        label: DISCUSSION_ASK_SHORTCUT.label,
      },
      {
        keys: modifierKeys(DISCUSSION_SEND_SHORTCUT),
        label: DISCUSSION_SEND_SHORTCUT.label,
      },
      {
        keys: modifierKeys(DISCUSSION_COLLAPSE_SHORTCUT),
        label: DISCUSSION_COLLAPSE_SHORTCUT.label,
      },
      { keys: ["↵"], label: "Show all turns (on “▸ N earlier turns”)" },
      { keys: ["Esc"], label: "Close and return to line" },
    ],
  },
];

/** Opens the comment card for a selection in assistant text. */
export const TRANSCRIPT_COMMENT_SHORTCUT = {
  modifiers: ["meta"],
  keys: ["Enter"],
  displayKey: "↵",
  label: "Comment on selection (assistant text)",
} as const satisfies ChatShortcutDefinition;

/** The transcript caret's bindings, listed in the ⌘⇧/ overlay. */
export const TRANSCRIPT_HINTS: readonly KeyHint[] = [
  { keys: ["⌘", "⌥", "↑"], label: "Into the transcript (from input or comments)" },
  { keys: ["← / →"], label: "Move by character" },
  { keys: ["↑ / ↓"], label: "Move by line" },
  { keys: ["⌥", "← / →"], label: "Move by word" },
  { keys: ["⌥", "↑ / ↓"], label: "Move by paragraph" },
  { keys: ["⌘", "← / →"], label: "Start / end of line" },
  { keys: ["⌘", "↑ / ↓"], label: "Start / end of message" },
  { keys: ["⇧"], label: "With any move: select as the caret moves" },
  { keys: modifierKeys(DIFF_COPY_SHORTCUT), label: "Copy selection" },
  {
    keys: modifierKeys(TRANSCRIPT_COMMENT_SHORTCUT),
    label: TRANSCRIPT_COMMENT_SHORTCUT.label,
  },
  { keys: ["Esc"], label: "Clear selection / back to input" },
  { keys: ["⌘", "⌥", "↓"], label: "Back to comments / input" },
];
