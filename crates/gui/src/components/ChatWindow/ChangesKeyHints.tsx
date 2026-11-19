import {
  CHANGED_FILE_LIST_KEYS,
  CHANGES_FOCUS_SHORTCUT,
  CHANGES_KEYS,
  COMPARISON_KEYS,
  presentChatShortcut,
} from "./chatShortcuts";

export function ChangesKeyHints({
  hasFiles,
  moveFile,
}: {
  hasFiles: boolean;
  moveFile(direction: -1 | 1): void;
}) {
  return (
    <footer
      className="changes-key-hints"
      aria-label="Changes keyboard shortcuts"
    >
      <span>
        <kbd>{presentChatShortcut(CHANGES_FOCUS_SHORTCUT)?.keys.join(" ")}</kbd>{" "}
        {CHANGES_FOCUS_SHORTCUT.label}
      </span>
      {[CHANGES_KEYS.base, CHANGES_KEYS.target, CHANGES_KEYS.files].map(
        ({ key, label }) => (
          <span key={key}>
            <kbd>{key}</kbd> {label}
          </span>
        )
      )}
      {(
        [
          [-1, CHANGES_KEYS.previous],
          [1, CHANGES_KEYS.next],
        ] as const
      ).map(([direction, { key, label }]) => (
        <button
          type="button"
          key={key}
          disabled={!hasFiles}
          onClick={() => moveFile(direction)}
          title={`${label} (${key})`}
          aria-keyshortcuts={key.toUpperCase()}
        >
          <kbd>{key}</kbd> {label}
        </button>
      ))}
      {[CHANGES_KEYS.diff, CHANGES_KEYS.file, CHANGES_KEYS.external].map(
        ({ key, label }) => (
          <span key={key}>
            <kbd>{key}</kbd> {label}
          </span>
        )
      )}
      <span>
        <kbd>{CHANGED_FILE_LIST_KEYS.keys.join(" ")}</kbd>{" "}
        {CHANGED_FILE_LIST_KEYS.label}
      </span>
      {COMPARISON_KEYS.map(({ keys, label }) => (
        <span key={label}>
          <kbd>{keys.join(" ")}</kbd> {label}
        </span>
      ))}
    </footer>
  );
}
