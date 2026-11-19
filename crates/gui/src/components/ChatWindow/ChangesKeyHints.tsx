import {
  changesHintsFor,
  type ChangesSituation,
} from "./chatShortcuts";

/**
 * The Changes key-hint footer: only the bindings for where focus is now,
 * ending with the binding for the full shortcut list.
 */
export function ChangesKeyHints({
  situation,
  split,
  hasFiles,
  moveFile,
}: {
  situation: ChangesSituation;
  split: boolean;
  hasFiles: boolean;
  moveFile(direction: -1 | 1): void;
}) {
  return (
    <footer
      className="changes-key-hints"
      tabIndex={0}
      aria-label="Changes keyboard shortcuts"
      data-situation={situation}
    >
      {changesHintsFor(situation, { split }).map(({ keys, label, move }) =>
        move ? (
          <button
            type="button"
            key={label}
            disabled={!hasFiles}
            onClick={() => moveFile(move)}
            title={`${label} (${keys.join("")})`}
            aria-keyshortcuts={keys.join("").toUpperCase()}
          >
            <kbd>{keys.join(" ")}</kbd> {label}
          </button>
        ) : (
          <span key={label}>
            <kbd>{keys.join(" ")}</kbd> {label}
          </span>
        )
      )}
    </footer>
  );
}
