import { CHAT_HELP_SHORTCUT, presentChatShortcut } from "./chatShortcuts";

const chatHelpKeys = presentChatShortcut(CHAT_HELP_SHORTCUT)?.keys ?? [];

export const CHAT_SHORTCUT_SECTIONS = [
  {
    title: "Panel",
    shortcuts: [
      { keys: ["⌥", "⌥"], label: "Toggle chat" },
      { keys: ["⌘", "\\"], label: "Maximize or collapse" },
      { keys: chatHelpKeys, label: CHAT_HELP_SHORTCUT.label },
      { keys: ["⌘", "⌥", "[ / ]"], label: "Previous/next conversation" },
      { keys: ["⌘", "F"], label: "Focus chat search" },
      { keys: ["Esc"], label: "Close hints or focused panel" },
    ],
  },
  {
    title: "Panes",
    shortcuts: [
      { keys: ["⌘", "⌥", "\\"], label: "Split pane" },
      { keys: ["⌘", "⇧", "⌥", "\\"], label: "Close active pane" },
      { keys: ["⌘", "⌥", "M"], label: "Keep only active pane" },
      { keys: ["⌘", "⌥", "←/→"], label: "Focus adjacent pane" },
      { keys: ["⌃", "Tab"], label: "Focus next pane" },
      { keys: ["⌘", "⌥", "1-6"], label: "Focus pane by number" },
    ],
  },
  {
    title: "Sessions",
    shortcuts: [
      { keys: ["⌘", "⇧", "⌥", "N"], label: "Fresh chat in active pane" },
      { keys: ["⌘", "⇧", "⌥", "H"], label: "History for active pane" },
      { keys: ["Enter"], label: "Send message" },
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
