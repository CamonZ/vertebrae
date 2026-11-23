import {
  CHAT_AREA_SHORTCUT,
  CHAT_FIND_SHORTCUT,
  CHAT_HELP_SHORTCUT,
  CHAT_SEARCH_SHORTCUT,
  CHAT_HISTORY_SHORTCUT,
  BACKGROUND_LIST_HINTS,
  CHANGES_HINT_GROUPS,
  DISCUSSION_LIST_HINTS,
  SIDE_COLUMN_SHORTCUTS,
  STOP_GENERATION_SHORTCUT,
  TRANSCRIPT_HINTS,
  WORKSPACE_SHORTCUTS,
  presentChatShortcut,
  type ChatShortcutDefinition,
} from "./chatShortcuts";

const chatHelpKeys = presentChatShortcut(CHAT_HELP_SHORTCUT)?.keys ?? [];

function hint(shortcut: ChatShortcutDefinition) {
  return {
    keys: presentChatShortcut(shortcut)?.keys ?? [],
    label: shortcut.label,
  };
}

/** Changes bindings by situation, each listed once (in its first group). */
function changesSections() {
  const listed = new Set<string>();
  return CHANGES_HINT_GROUPS.map(({ title, hints }) => ({
    title,
    shortcuts: hints
      .filter(({ keys, label }) => {
        const id = `${keys.join(" ")}\u0000${label}`;
        if (listed.has(id)) return false;
        listed.add(id);
        return true;
      })
      .map(({ keys, label, splitOnly }) => ({
        keys,
        label: splitOnly ? `${label} (split)` : label,
      })),
  }));
}

export const CHAT_SHORTCUT_SECTIONS = [
  {
    title: "Panel",
    shortcuts: [
      { keys: ["⌥", "⌥"], label: "Toggle chat" },
      hint(WORKSPACE_SHORTCUTS.toggleExpanded),
      { keys: chatHelpKeys, label: CHAT_HELP_SHORTCUT.label },
      { keys: ["⌘", "⌥", "[ / ]"], label: "Previous/next project" },
      { keys: ["⌘", "K"], label: "Commands for the focused area" },
      hint(CHAT_FIND_SHORTCUT),
      hint(CHAT_SEARCH_SHORTCUT),
      hint(CHAT_HISTORY_SHORTCUT),
      hint(SIDE_COLUMN_SHORTCUTS.toggle),
      hint(SIDE_COLUMN_SHORTCUTS.changes),
      hint(SIDE_COLUMN_SHORTCUTS.discussions),
      hint(SIDE_COLUMN_SHORTCUTS.background),
      { keys: ["← / →"], label: "Switch section (section tabs focused)" },
      { keys: ["Esc"], label: "Close hints or focused panel" },
    ],
  },
  {
    title: "Transcript",
    shortcuts: TRANSCRIPT_HINTS.map(({ keys, label }) => ({ keys, label })),
  },
  ...changesSections(),
  {
    title: "Discussions",
    shortcuts: DISCUSSION_LIST_HINTS.map(({ keys, label }) => ({
      keys,
      label,
    })),
  },
  {
    title: "Background tasks",
    shortcuts: BACKGROUND_LIST_HINTS.map(({ keys, label }) => ({
      keys,
      label,
    })),
  },
  {
    title: "Chats",
    shortcuts: [
      hint(WORKSPACE_SHORTCUTS.nextChat),
      hint(WORKSPACE_SHORTCUTS.previousChat),
      hint(WORKSPACE_SHORTCUTS.nextChatTab),
      hint(WORKSPACE_SHORTCUTS.previousChatTab),
      hint(WORKSPACE_SHORTCUTS.chatByNumber),
      hint(WORKSPACE_SHORTCUTS.nextNeedingYou),
      hint(WORKSPACE_SHORTCUTS.previousNeedingYou),
      hint(WORKSPACE_SHORTCUTS.moveChatLeft),
      hint(WORKSPACE_SHORTCUTS.moveChatRight),
      hint(WORKSPACE_SHORTCUTS.freshChat),
      hint(WORKSPACE_SHORTCUTS.closeChat),
      hint(CHAT_AREA_SHORTCUT),
    ],
  },
  {
    title: "Sessions",
    shortcuts: [
      {
        keys: ["⌘", "⌥", "⇧", "[ / ]"],
        label: "Previous/next conversation in project",
      },
      {
        keys: ["⌘", "⇧", "⌥", "N"],
        label: "Fresh chat in selected project (active pane)",
      },
      { keys: ["⌘", "⇧", "⌥", "H"], label: "History for active pane" },
      { keys: ["Enter"], label: "Send or queue during an active turn" },
      hint(STOP_GENERATION_SHORTCUT),
      {
        keys: ["⌃", "Enter"],
        label: "Steer the active turn from the composer",
      },
      {
        keys: ["⌘", "⌥", "↑ / ↓"],
        label: "Up to pending comments, then the transcript / back down",
      },
      { keys: ["⇧", "Enter"], label: "New line" },
    ],
  },
];

interface ChatShortcutHintsProps {
  onClose: () => void;
}

/** Modal-style keyboard-shortcuts overlay for the chat panel. */
export function ChatShortcutHints({ onClose }: ChatShortcutHintsProps) {
  return (
    <div className="hc-shortcuts-layer">
      <section
        role="dialog"
        aria-modal="true"
        aria-label="Chat keyboard shortcuts"
        className="hc-shortcuts"
      >
        <header className="hc-shortcuts-head">
          <div>
            <p className="hc-shortcuts-eyebrow">Keyboard</p>
            <h2>Chat shortcuts</h2>
          </div>
          <button
            type="button"
            className="hc-ctrl"
            onClick={onClose}
            title="Close keyboard shortcuts"
            aria-label="Close keyboard shortcuts"
          >
            <svg
              className="h-3.5 w-3.5"
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M6 18L18 6M6 6l12 12"
              />
            </svg>
          </button>
        </header>
        <div className="hc-shortcuts-body">
          {CHAT_SHORTCUT_SECTIONS.map((section) => (
            <section key={section.title} className="hc-shortcuts-section">
              <h3>{section.title}</h3>
              <dl>
                {section.shortcuts.map((shortcut) => (
                  <div key={`${section.title}:${shortcut.label}`}>
                    <dt>
                      {shortcut.keys.map((key, index) => (
                        <kbd key={`${key}:${index}`}>{key}</kbd>
                      ))}
                    </dt>
                    <dd>{shortcut.label}</dd>
                  </div>
                ))}
              </dl>
            </section>
          ))}
        </div>
      </section>
    </div>
  );
}
