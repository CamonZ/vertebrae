import type { WorktreeChanges as Changes } from "../../../bindings";

/** The loaded comparison's totals and what it includes. */
export function ChangesSummary({
  data,
  viewedCount,
}: {
  data: Changes;
  viewedCount: number;
}) {
  const fileCount = data.files.length;
  return (
    <div className="changes-summary" role="status">
      <div className="changes-totals" aria-label="Comparison totals">
        <span className="changes-total-files">
          {fileCount} <span>{fileCount === 1 ? "file" : "files"}</span>
        </span>
        <span className="changes-total-added">+{data.totals.additions}</span>
        <span className="changes-total-deleted">−{data.totals.deletions}</span>
        {viewedCount > 0 && (
          <span className="changes-total-viewed">
            {viewedCount}/{fileCount} viewed
          </span>
        )}
        {data.totals.binary_files > 0 && (
          <span className="changes-total-binary">
            {data.totals.binary_files} binary
          </span>
        )}
      </div>
      <span className="changes-summary-note">
        {data.comparison.working_tree
          ? "Includes active working tree: staged, unstaged and untracked"
          : "Committed contents only · read-only · linked worktree dirty files excluded"}
      </span>
    </div>
  );
}
