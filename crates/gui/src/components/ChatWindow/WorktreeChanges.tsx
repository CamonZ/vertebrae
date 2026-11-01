import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type KeyboardEvent,
} from "react";
import {
  commands,
  type FileStatus,
  type WorktreeChanges as Changes,
} from "../../bindings";
import { countPatchLines } from "../thread/toolChange/worktreeDelta";
import {
  parseWorktreeSnapshot,
  type WorktreeSnapshot,
} from "../thread/toolChange/diffComments";

import { Select } from "../atoms/Select";
import { preloadDiffRenderer } from "../thread/toolChange/useWorktreeDelta";
import {
  activate,
  closeDocument,
  discardDraft,
  documentOf,
  isDirty,
  openDocument,
  releaseCleanDocuments,
  saveDocument,
  saveDocuments,
  useDocumentStore,
} from "./workspace/documentStore";
import { DocumentPane } from "./workspace/DocumentPane";
import { useWorktreeWatch } from "./workspace/useWorktreeWatch";
import { FilesTree } from "./workspace/FilesTree";
import { STATUS_LETTER } from "./workspace/status";
import { UnsavedChangesDialog } from "./workspace/UnsavedChangesDialog";
import type { JumpTarget } from "./workspace/AllChangesView";
import "./worktreeChanges.css";

const AllChangesView = lazy(() => import("./workspace/AllChangesView"));

const NO_PATHS: readonly string[] = [];

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Changes; wholeBranch: boolean };

type SidebarMode = "changes" | "files";

/**
 * The worktree workspace: Git changes and a file browser in the sidebar,
 * every change in one virtualized viewport, and open documents edited as
 * files or diffs. Documents hold the file as read; the lists refresh after a
 * save, on request, or after filesystem notifications. Drafts survive
 * unmounting in the per-worktree store.
 */
export function WorktreeChanges({
  worktreePath,
  onChangesLoaded,
}: {
  worktreePath: string;
  /** Called with the parsed All Changes patch after every successful load. */
  onChangesLoaded?: (snapshot: WorktreeSnapshot) => void;
}) {
  const [wholeBranch, setWholeBranch] = useState(false);
  // Background refreshes keep the current list visible while Git runs.
  const [refresh, setRefresh] = useState({ count: 0, background: false });
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [generation, setGeneration] = useState(0);
  const [filesOpen, setFilesOpen] = useState(true);
  const [mode, setMode] = useState<SidebarMode>("changes");
  const [activePath, setActivePath] = useState<string | null>(null);
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | null>(null);
  const [treeToken, setTreeToken] = useState(0);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const fileListId = useId();
  const [baseBranch, setBaseBranch] = useState<string | null>(null);
  // Narrow selections: typing in a draft must not re-render the workspace.
  const order = useDocumentStore(
    (store) => store.workspaces[worktreePath]?.order ?? NO_PATHS
  );
  const activeDocument = useDocumentStore(
    (store) => store.workspaces[worktreePath]?.active ?? null
  );
  const dirtyKey = useDocumentStore((store) => {
    const workspace = store.workspaces[worktreePath];
    return (workspace?.order ?? NO_PATHS)
      .filter((path) => isDirty(workspace?.documents[path]))
      .join("\n");
  });
  const dirty = useMemo(() => new Set(dirtyKey.split("\n")), [dirtyKey]);

  // Warm Pierre and its highlight workers while Git computes the changes.
  useEffect(preloadDiffRenderer, []);
  const requestLoad = useRef<(() => void) | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  useEffect(() => {
    let current = true;
    let running = false;
    let pending = false;
    const load = async () => {
      pending = true;
      if (running) return;
      running = true;
      while (current && pending) {
        pending = false;
        if (!refreshRef.current.background) setState({ status: "loading" });
        try {
          const result = await commands.loadWorktreeChanges(
            worktreePath,
            wholeBranch
          );
          if (!current) break;
          if (result.status === "error") {
            setState({ status: "error", message: result.error.message });
          } else {
            setBaseBranch(result.data.base_branch);
            setState({ status: "ready", data: result.data, wholeBranch });
            setGeneration((value) => value + 1);
          }
        } catch (error) {
          if (current) setState({ status: "error", message: String(error) });
        }
      }
      running = false;
    };
    requestLoad.current = () => {
      void load();
    };
    return () => {
      current = false;
      requestLoad.current = null;
    };
  }, [worktreePath, wholeBranch]);
  useEffect(() => {
    requestLoad.current?.();
  }, [worktreePath, wholeBranch, refresh]);

  const onChangesLoadedRef = useRef(onChangesLoaded);
  onChangesLoadedRef.current = onChangesLoaded;
  useEffect(() => {
    if (state.status !== "ready") return;
    onChangesLoadedRef.current?.(
      parseWorktreeSnapshot(
        state.wholeBranch,
        state.data.files
          .filter((file) => !file.marker)
          .map((file) => file.patch)
      )
    );
  }, [state]);

  const refreshAll = useCallback(() => {
    setRefresh((value) => ({ count: value.count + 1, background: true }));
    setTreeToken((value) => value + 1);
  }, []);

  const watchError = useWorktreeWatch(worktreePath, refreshAll);

  useEffect(() => () => releaseCleanDocuments(worktreePath), [worktreePath]);

  const files = useMemo(
    () =>
      state.status === "ready"
        ? state.data.files.map((item) => {
            const counts = [...countPatchLines(item.patch).values()].reduce(
              (sum, value) => ({
                additions: sum.additions + value.additions,
                deletions: sum.deletions + value.deletions,
              }),
              { additions: 0, deletions: 0 }
            );
            return { ...item, summary: counts };
          })
        : [],
    [state]
  );
  const statuses = useMemo(
    () =>
      new Map<string, FileStatus>(
        files.map((file) => [file.path, file.status])
      ),
    [files]
  );

  const jumpToFile = (path: string) => {
    setActivePath(path);
    activate(worktreePath, null);
    setJumpTarget((current) => ({ path, nonce: (current?.nonce ?? 0) + 1 }));
  };
  const open = (path: string, view: "file" | "diff") => {
    setActivePath(path);
    openDocument(worktreePath, path, view);
  };
  const save = (path: string) =>
    void saveDocument(worktreePath, path).then((saved) => {
      if (saved) refreshAll();
    });
  const requestClose = (path: string) => {
    if (isDirty(documentOf(worktreePath, path))) setClosing(path);
    else closeDocument(worktreePath, path);
  };
  const onKeyDownCapture = (event: KeyboardEvent) => {
    if (
      closing == null &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      if (activeDocument) save(activeDocument);
    }
  };

  const changesBody =
    state.status === "loading" ? (
      <p role="status">Loading changes…</p>
    ) : state.status === "error" ? (
      <p role="alert">{state.message}</p>
    ) : files.length === 0 ? (
      <p>No changes against this baseline.</p>
    ) : (
      <div aria-label="All file diffs" className="changes-viewport">
        <Suspense fallback={<p role="status">Loading diffs…</p>}>
          <AllChangesView
            files={state.data.files}
            jumpTarget={jumpTarget}
            onOpen={(path) => open(path, "diff")}
          />
        </Suspense>
      </div>
    );

  return (
    <section
      aria-label="Worktree changes"
      className="flex min-h-0 flex-1 flex-col gap-2 p-3 text-sm"
      onKeyDownCapture={onKeyDownCapture}
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-[var(--color-fg-mute)]">
          Baseline
          <Select
            aria-label="Changes baseline"
            value={wholeBranch ? "branch" : "head"}
            onChange={(event) => {
              setWholeBranch(event.target.value === "branch");
              setRefresh((value) => ({
                count: value.count + 1,
                background: false,
              }));
            }}
            options={[
              { value: "head", label: "Uncommitted · working tree vs HEAD" },
              ...(baseBranch
                ? [
                    {
                      value: "branch",
                      label: `Whole branch · merge-base with ${baseBranch}`,
                    },
                  ]
                : []),
            ]}
          />
        </label>
        <button
          type="button"
          className="changes-refresh"
          aria-label="Refresh changes"
          title="Refresh changes"
          disabled={state.status === "loading"}
          onClick={() => {
            setRefresh((value) => ({
              count: value.count + 1,
              background: false,
            }));
            setTreeToken((value) => value + 1);
          }}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
            aria-hidden="true"
          >
            <path d="M20 7v5h-5M4 17v-5h5" />
            <path d="M6.1 7a7 7 0 0 1 11.5-1L20 9M4 15l2.4 3A7 7 0 0 0 17.9 17" />
          </svg>
        </button>
      </div>
      {watchError && (
        <p role="status">
          Automatic refresh unavailable: {watchError}. Use Refresh to update.
        </p>
      )}
      {state.status === "ready" && state.data.base_unavailable && (
        <p role="status">{state.data.base_unavailable}</p>
      )}
      <div className="flex min-h-0 flex-1 gap-3">
        <aside
          className={`changes-files-panel${filesOpen ? "" : " is-collapsed"}`}
        >
          <div className="changes-files-header">
            {filesOpen && (
              <div
                role="group"
                aria-label="Sidebar mode"
                className="changes-modes"
              >
                <button
                  type="button"
                  aria-pressed={mode === "changes"}
                  onClick={() => setMode("changes")}
                >
                  Changes{" "}
                  <span className="changes-files-count">{files.length}</span>
                </button>
                <button
                  type="button"
                  aria-pressed={mode === "files"}
                  onClick={() => setMode("files")}
                >
                  Files
                </button>
              </div>
            )}
            <button
              type="button"
              className="changes-files-toggle"
              aria-label={filesOpen ? "Hide files" : "Show files"}
              title={filesOpen ? "Collapse file list" : "Expand file list"}
              aria-expanded={filesOpen}
              aria-controls={filesOpen ? fileListId : undefined}
              onClick={() => setFilesOpen((value) => !value)}
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                aria-hidden="true"
              >
                <rect x="3" y="4" width="18" height="16" rx="2" />
                <path d="M9 4v16" />
                <path d={filesOpen ? "m16 9-3 3 3 3" : "m13 9 3 3-3 3"} />
              </svg>
            </button>
          </div>
          {filesOpen && (
            <div id={fileListId} className="flex min-h-0 flex-1 flex-col">
              {mode === "changes" && files.length > 0 && (
                <nav aria-label="Changed files" className="changes-files-list">
                  <ul>
                    {files.map((item) => {
                      const slash = item.path.lastIndexOf("/");
                      const name = item.path.slice(slash + 1);
                      const directory = item.path.slice(0, slash);
                      const label = item.old_path
                        ? `${item.old_path} → ${item.path}`
                        : item.path;
                      return (
                        <li key={item.path} className="changes-file-item">
                          <button
                            type="button"
                            className="changes-file-row"
                            aria-label={`Jump to ${item.path}`}
                            aria-current={
                              activePath === item.path ? "location" : undefined
                            }
                            title={label}
                            onClick={() => jumpToFile(item.path)}
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
                                <span className="changes-file-directory">
                                  {directory}
                                </span>
                              )}
                              {item.old_path && (
                                <span className="changes-file-directory">
                                  from {item.old_path}
                                </span>
                              )}
                            </span>
                            {!item.marker && (
                              <span className="changes-file-stats">
                                <span className="changes-file-added">
                                  +{item.summary.additions}
                                </span>
                                <span className="changes-file-deleted">
                                  −{item.summary.deletions}
                                </span>
                              </span>
                            )}
                          </button>
                          <button
                            type="button"
                            className="changes-file-open"
                            aria-label={`Open ${item.path}`}
                            title="Open file"
                            onClick={() => open(item.path, "diff")}
                          >
                            <svg
                              width="14"
                              height="14"
                              viewBox="0 0 24 24"
                              fill="none"
                              stroke="currentColor"
                              strokeWidth="1.5"
                              strokeLinecap="round"
                              strokeLinejoin="round"
                              aria-hidden="true"
                            >
                              <path d="M12 20h9" />
                              <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z" />
                            </svg>
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
              )}
              <div
                hidden={mode !== "files"}
                className="flex min-h-0 flex-1 flex-col"
              >
                <FilesTree
                  worktreePath={worktreePath}
                  statuses={statuses}
                  activePath={activeDocument}
                  refreshToken={treeToken}
                  onOpen={(path) => open(path, "file")}
                />
              </div>
            </div>
          )}
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <nav aria-label="Open documents" className="changes-tabs">
            <button
              type="button"
              className="changes-tab"
              aria-current={activeDocument == null ? "page" : undefined}
              onClick={() => activate(worktreePath, null)}
            >
              All changes
            </button>
            {order.map((path) => (
              <span key={path} className="changes-tab-group">
                <button
                  type="button"
                  className="changes-tab"
                  aria-current={activeDocument === path ? "page" : undefined}
                  title={path}
                  onClick={() => {
                    setActivePath(path);
                    activate(worktreePath, path);
                  }}
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
                  onClick={() => requestClose(path)}
                >
                  ×
                </button>
              </span>
            ))}
          </nav>
          {activeDocument == null ? (
            changesBody
          ) : (
            <DocumentPane
              key={activeDocument}
              worktreePath={worktreePath}
              path={activeDocument}
              change={files.find((file) => file.path === activeDocument)}
              wholeBranch={wholeBranch}
              changesGeneration={generation}
              onSave={save}
              onSaved={refreshAll}
            />
          )}
        </div>
      </div>
      <UnsavedChangesDialog
        paths={closing ? [closing] : null}
        busy={closeBusy}
        onCancel={() => setClosing(null)}
        onDiscard={() => {
          if (closing) {
            discardDraft(worktreePath, closing);
            closeDocument(worktreePath, closing);
          }
          setClosing(null);
        }}
        onSave={() => {
          if (!closing) return;
          setCloseBusy(true);
          void saveDocuments(worktreePath, [closing])
            .then((failed) => {
              if (failed.length === 0) {
                closeDocument(worktreePath, closing);
                refreshAll();
              } else {
                // Keep the document open on the error or conflict it shows.
                setActivePath(closing);
                activate(worktreePath, closing);
              }
            })
            .finally(() => {
              setCloseBusy(false);
              setClosing(null);
            });
        }}
      />
    </section>
  );
}
