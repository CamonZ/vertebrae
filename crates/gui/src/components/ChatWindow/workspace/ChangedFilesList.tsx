import type { Ref } from "react";
import type { WorktreeChange } from "../../../bindings";
import { STATUS_LETTER } from "./status";

/**
 * The sidebar's changed files. One row is in the tab order (the selected
 * file); ↑/↓ between rows is handled by Changes' key handler.
 */
export function ChangedFilesList({
  listRef,
  files,
  selectedPath,
  activePath,
  onJump,
}: {
  listRef: Ref<HTMLElement>;
  files: readonly WorktreeChange[];
  selectedPath: string | null;
  activePath: string | null;
  onJump(path: string): void;
}) {
  return (
    <nav
      ref={listRef}
      tabIndex={-1}
      aria-label="Changed files"
      aria-keyshortcuts="ArrowUp ArrowDown"
      className="changes-files-list"
    >
      <ul>
        {files.map((item) => {
          const slash = item.path.lastIndexOf("/");
          const name = item.path.slice(slash + 1);
          const directory = item.path.slice(0, slash);
          const label = item.old_path
            ? `${item.old_path} → ${item.path}`
            : item.path;
          return (
            <li
              key={item.path}
              data-changes-path={item.path}
              className="changes-file-item"
            >
              <button
                type="button"
                className="changes-file-row"
                aria-label={`Jump to ${item.path}`}
                tabIndex={item.path === selectedPath ? 0 : -1}
                aria-current={activePath === item.path ? "location" : undefined}
                title={label}
                onClick={() => onJump(item.path)}
              >
                <span
                  className={`changes-file-status is-${item.status}`}
                  title={item.status}
                >
                  {STATUS_LETTER[item.status]}
                </span>
                <span className="changes-file-path">
                  <span className="changes-file-name">{name}</span>
                  {slash >= 0 && (
                    <span className="changes-file-directory">{directory}</span>
                  )}
                  {item.old_path && (
                    <span className="changes-file-directory">
                      from {item.old_path}
                    </span>
                  )}
                </span>
                {item.totals.binary_files === 0 && (
                  <span className="changes-file-stats">
                    <span className="changes-file-added">
                      +{item.totals.additions}
                    </span>
                    <span className="changes-file-deleted">
                      −{item.totals.deletions}
                    </span>
                  </span>
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
