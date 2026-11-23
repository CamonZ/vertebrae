export type ChatShortcutModifier = "ctrl" | "meta" | "alt" | "shift";

export interface ChatShortcutDefinition {
  readonly modifiers: readonly ChatShortcutModifier[];
  readonly keys: readonly string[];
  /**
   * Physical key codes, matched before `keys`: ⌥ changes the character a key
   * types (⌥J types ∆), so letter, digit and backslash bindings use codes.
   */
  readonly codes?: readonly string[];
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
  Partial<Pick<KeyboardEvent, "altKey" | "ctrlKey" | "code">>;

export function matchesChatShortcut(
  event: ShortcutEvent,
  shortcut: ChatShortcutDefinition
): boolean {
  const state = modifierState(event);
  return (
    shortcut.modifiers.every((modifier) => state[modifier]) &&
    shortcut.keys.includes(event.key)
  );
}

function modifierState(
  event: ShortcutEvent
): Record<ChatShortcutModifier, boolean> {
  return {
    ctrl: event.ctrlKey ?? false,
    meta: event.metaKey,
    alt: event.altKey ?? false,
    shift: event.shiftKey,
  };
}

/**
 * Exactly these modifiers and this key (code first, then character), so
 * ⌘⌥\ never fires for ⌘⌥⇧\. Workspace bindings use this matcher.
 */
export function matchesExactChatShortcut(
  event: ShortcutEvent,
  shortcut: ChatShortcutDefinition
): boolean {
  const state = modifierState(event);
  const modifiersMatch = (Object.keys(state) as ChatShortcutModifier[]).every(
    (modifier) => state[modifier] === shortcut.modifiers.includes(modifier)
  );
  if (!modifiersMatch) return false;
  if (event.code && shortcut.codes?.includes(event.code)) return true;
  return shortcut.keys.includes(event.key);
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
    if (modifier === "ctrl") return apple ? "⌃" : "Ctrl";
    if (modifier === "meta") return apple ? "⌘" : "Meta";
    if (modifier === "alt") return apple ? "⌥" : "Alt";
    return apple ? "⇧" : "Shift";
  });
  keys.push(shortcut.displayKey);

  const accessibleModifiers = shortcut.modifiers.map((modifier) => {
    if (modifier === "ctrl") return "Control";
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
 * Moves focus inside the active chat: its composer ↔ its side column's shown
 * section, wrapping. It never switches tabs (decision 49d12c2c §4).
 */
export const CHAT_AREA_SHORTCUT = {
  modifiers: ["meta", "alt"],
  keys: ["ArrowLeft", "ArrowRight"],
  displayKey: "← / →",
  label: "Move between composer and side column",
} as const satisfies ChatShortcutDefinition;

/** ⌘B shows or hides chat history; from the compact panel it expands. */
export const CHAT_HISTORY_SHORTCUT = {
  modifiers: ["meta"],
  keys: ["b", "B"],
  codes: ["KeyB"],
  displayKey: "B",
  label: "Show or hide chat history",
} as const satisfies ChatShortcutDefinition;

/** ⌘F finds within the active chat's transcript. */
export const CHAT_FIND_SHORTCUT = {
  modifiers: ["meta"],
  keys: ["f", "F"],
  codes: ["KeyF"],
  displayKey: "F",
  label: "Find in conversation",
} as const satisfies ChatShortcutDefinition;

/** ⌘⇧F searches chat history. */
export const CHAT_SEARCH_SHORTCUT = {
  modifiers: ["meta", "shift"],
  keys: ["f", "F"],
  codes: ["KeyF"],
  displayKey: "F",
  label: "Search chats",
} as const satisfies ChatShortcutDefinition;

/** ⌘. stops the active turn (handled by the chat while it can stop). */
export const STOP_GENERATION_SHORTCUT = {
  modifiers: ["meta"],
  keys: ["."],
  codes: ["Period"],
  displayKey: ".",
  label: "Stop generation",
} as const satisfies ChatShortcutDefinition;

const BACKSLASH = { keys: ["\\", "|"], codes: ["Backslash"], displayKey: "\\" };

/**
 * Chat workspace bindings (decision 49d12c2c §4). Each addresses the ordered
 * list of open chats (the tab strip). The dispatcher, tooltips and the ⌘⇧/
 * sheet all read these definitions.
 */
export const WORKSPACE_SHORTCUTS = {
  toggleExpanded: {
    modifiers: ["meta"],
    ...BACKSLASH,
    label: "Expand or collapse chat workspace",
  },
  nextChat: {
    modifiers: ["ctrl"],
    keys: ["Tab"],
    displayKey: "Tab",
    label: "Next chat",
  },
  previousChat: {
    modifiers: ["ctrl", "shift"],
    keys: ["Tab"],
    displayKey: "Tab",
    label: "Previous chat",
  },
  // The macOS previous / next tab keys. Brackets match on codes: ⇧[ types {.
  nextChatTab: {
    modifiers: ["meta", "shift"],
    keys: ["]", "}"],
    codes: ["BracketRight"],
    displayKey: "]",
    label: "Next chat tab",
  },
  previousChatTab: {
    modifiers: ["meta", "shift"],
    keys: ["[", "{"],
    codes: ["BracketLeft"],
    displayKey: "[",
    label: "Previous chat tab",
  },
  chatByNumber: {
    modifiers: ["meta", "alt"],
    keys: ["1", "2", "3", "4", "5", "6", "7", "8", "9"],
    codes: [1, 2, 3, 4, 5, 6, 7, 8, 9].map((digit) => `Digit${digit}`),
    displayKey: "1–9",
    label: "Go to chat N (9: last)",
  },
  nextNeedingYou: {
    modifiers: ["meta", "alt"],
    keys: ["j", "J"],
    codes: ["KeyJ"],
    displayKey: "J",
    label: "Next chat needing you",
  },
  previousNeedingYou: {
    modifiers: ["meta", "alt", "shift"],
    keys: ["j", "J"],
    codes: ["KeyJ"],
    displayKey: "J",
    label: "Previous chat needing you",
  },
  moveChatLeft: {
    modifiers: ["meta", "alt", "shift"],
    keys: ["ArrowLeft"],
    displayKey: "←",
    label: "Move chat left",
  },
  moveChatRight: {
    modifiers: ["meta", "alt", "shift"],
    keys: ["ArrowRight"],
    displayKey: "→",
    label: "Move chat right",
  },
  freshChat: {
    modifiers: ["meta", "alt"],
    ...BACKSLASH,
    label: "New chat after the active one",
  },
  closeChat: {
    modifiers: ["meta", "alt", "shift"],
    ...BACKSLASH,
    label: "Close chat",
  },
} as const satisfies Record<string, ChatShortcutDefinition>;

export type WorkspaceShortcutId = keyof typeof WORKSPACE_SHORTCUTS;

/**
 * The chat's side column (Changes · Discussions · Background tasks): ⌘⇧B
 * for the column, ⌃⌘1–3 for a section by its place in the switcher (⌘⇧3–5
 * belong to macOS screenshots). Digits match on codes.
 */
export const SIDE_COLUMN_SHORTCUTS = {
  toggle: {
    modifiers: ["meta", "shift"],
    keys: ["b", "B"],
    codes: ["KeyB"],
    displayKey: "B",
    label: "Show or hide the side column",
  },
  changes: {
    modifiers: ["ctrl", "meta"],
    keys: ["1"],
    codes: ["Digit1"],
    displayKey: "1",
    label: "Show or hide Changes",
  },
  discussions: {
    modifiers: ["ctrl", "meta"],
    keys: ["2"],
    codes: ["Digit2"],
    displayKey: "2",
    label: "Show or hide Discussions",
  },
  background: {
    modifiers: ["ctrl", "meta"],
    keys: ["3"],
    codes: ["Digit3"],
    displayKey: "3",
    label: "Show or hide Background tasks",
  },
} as const satisfies Record<string, ChatShortcutDefinition>;

export type SideColumnShortcutId = keyof typeof SIDE_COLUMN_SHORTCUTS;

/** Tooltip text: `Label · ⌘⌥J`. */
export function shortcutTooltip(
  label: string,
  shortcut: ChatShortcutDefinition
): string {
  const keys = shortcutText(shortcut);
  return keys ? `${label} · ${keys}` : label;
}

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

const ARIA_MODIFIER: Record<ChatShortcutModifier, string> = {
  ctrl: "Control",
  meta: "Meta",
  alt: "Alt",
  shift: "Shift",
};

/** The `aria-keyshortcuts` form of a shortcut, e.g. `Meta+Shift+B`. */
export function ariaKeyShortcut(shortcut: ChatShortcutDefinition): string {
  return [
    ...shortcut.modifiers.map((m) => ARIA_MODIFIER[m]),
    shortcut.displayKey,
  ].join("+");
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
/** ⌥⇧↑/↓: previous / next file heading in Changes. */
export const CHANGES_FILE_JUMP_KEYS = {
  previous: { keys: ["⌥", "⇧", "↑"], label: "Previous file" },
  next: { keys: ["⌥", "⇧", "↓"], label: "Next file" },
} as const satisfies Record<string, KeyHint>;
const FILE_JUMP_HINTS: KeyHint[] = [
  CHANGES_FILE_JUMP_KEYS.previous,
  CHANGES_FILE_JUMP_KEYS.next,
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
      ...RESIZE_HINTS,
    ],
  },
  {
    title: "Changes · file list",
    hints: [
      {
        keys: CHANGED_FILE_LIST_KEYS.keys,
        label: CHANGED_FILE_LIST_KEYS.label,
      },
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
      {
        keys: modifierKeys(DIFF_COPY_SHORTCUT),
        label: DIFF_COPY_SHORTCUT.label,
      },
      { keys: ["c / ↵"], label: "Discuss selection" },
      { keys: [DISCUSSION_OPEN_KEY], label: "Open discussion at line" },
      {
        keys: modifierKeys(DISCUSSION_COLLAPSE_SHORTCUT),
        label: "Collapse or expand the discussion at line",
      },
      { keys: [CHANGES_VIEWED_KEY], label: "Mark file viewed, go to next" },
      CHANGES_UNVIEW_HINT,
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

/** The Discussions section's list (one row per selection thread). */
export const DISCUSSION_LIST_KEYS = {
  move: { keys: ["↑", "↓"], label: "Previous / next discussion" },
  reply: { keys: ["↵"], label: "Open and reply" },
  showCode: { keys: [DISCUSSION_OPEN_KEY], label: "Show its code in Changes" },
  copy: { keys: modifierKeys(DIFF_COPY_SHORTCUT), label: "Copy original code" },
  fold: { keys: ["← / →"], label: "Fold / unfold earlier turns" },
} as const satisfies Record<string, KeyHint>;

export const DISCUSSION_LIST_HINTS: readonly KeyHint[] =
  Object.values(DISCUSSION_LIST_KEYS);

/** The Background tasks section's list. */
export const BACKGROUND_LIST_KEYS = {
  move: { keys: ["↑", "↓"], label: "Previous / next task" },
  output: { keys: ["↵"], label: "Show or hide output" },
  copy: { keys: modifierKeys(DIFF_COPY_SHORTCUT), label: "Copy command" },
} as const satisfies Record<string, KeyHint>;

export const BACKGROUND_LIST_HINTS: readonly KeyHint[] =
  Object.values(BACKGROUND_LIST_KEYS);

/** The text a key hint shows, e.g. `↑↓` or `⌘C`: palette and sheet agree. */
export function keyHintText(hint: Pick<KeyHint, "keys">): string {
  return hint.keys.join("");
}

/** Opens the comment card for a selection in assistant text. */
export const TRANSCRIPT_COMMENT_SHORTCUT = {
  modifiers: ["meta"],
  keys: ["Enter"],
  displayKey: "↵",
  label: "Comment on selection (assistant text)",
} as const satisfies ChatShortcutDefinition;

/** The transcript caret's bindings, listed in the ⌘⇧/ overlay. */
export const TRANSCRIPT_HINTS: readonly KeyHint[] = [
  {
    keys: ["⌘", "⌥", "↑"],
    label: "Into the transcript (from input or comments)",
  },
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
