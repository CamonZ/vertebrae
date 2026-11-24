/**
 * "All changes" and one tab per open document, each closable. Historical
 * comparisons show no document tabs: their documents are read-only views.
 */
export function OpenDocumentTabs({
  showingChanges,
  documents,
  currentDocument,
  dirty,
  onShowChanges,
  onActivate,
  onClose,
}: {
  showingChanges: boolean;
  documents: readonly string[];
  /** The document shown, if a document is. */
  currentDocument: string | null;
  dirty: ReadonlySet<string>;
  onShowChanges(): void;
  onActivate(path: string): void;
  onClose(path: string): void;
}) {
  // "All changes" alone is a label for the only view: no row until a second
  // view (an open document, a turn or a historical file) exists.
  if (showingChanges && documents.length === 0) return null;
  return (
    <nav aria-label="Open documents" className="changes-tabs workspace-tabs">
      <button
        type="button"
        className="changes-tab"
        aria-current={showingChanges ? "page" : undefined}
        onClick={onShowChanges}
      >
        All changes
      </button>
      {documents.map((path) => (
        <span key={path} className="changes-tab-group">
          <button
            type="button"
            className="changes-tab"
            aria-current={currentDocument === path ? "page" : undefined}
            title={path}
            onClick={() => onActivate(path)}
          >
            {path.slice(path.lastIndexOf("/") + 1)}
            {dirty.has(path) && (
              <span className="changes-tab-dirty">
                <span aria-hidden="true">{" ●"}</span>
                <span className="sr-only"> (unsaved)</span>
              </span>
            )}
          </button>
          <button
            type="button"
            className="changes-tab-close"
            aria-label={`Close ${path}`}
            onClick={() => onClose(path)}
          >
            ×
          </button>
        </span>
      ))}
    </nav>
  );
}
