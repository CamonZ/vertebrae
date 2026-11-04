import { backgroundClient } from "../../background/client";
import type { BackgroundTask, BackgroundOutputs } from "../../background/types";

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
  type ComparisonRequest,
  type ComparisonEndpoint,
  type ComparisonChoice,
  type WorktreeChanges as Changes,
} from "../../bindings";
import { usePierreDiffOptions } from "../../hooks/useCodeAppearance";
import { useSidebarResize } from "./workspace/useSidebarResize";
import { HistoricalDocument } from "./workspace/HistoricalDocument";
import { type WorktreeSnapshot } from "../thread/toolChange/diffComments";

import { ComparisonSelect } from "./workspace/ComparisonSelect";
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
import "./workspaceTabs.css";
import "./worktreeChanges.css";

const AllChangesView = lazy(() => import("./workspace/AllChangesView"));

const NO_PATHS: readonly string[] = [];

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | {
      status: "ready";
      data: Changes;
      wholeBranch: boolean;
      parsed: BackgroundOutputs["patch"];
    };

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
  const [base, setBase] = useState<ComparisonEndpoint | null>(null);
  const [target, setTarget] = useState<ComparisonEndpoint>({
    kind: "working_tree",
  });
  const preferredDiffOptions = usePierreDiffOptions();
  const [diffStyle, setDiffStyle] = useState(preferredDiffOptions.diffStyle);
  const wholeBranch = base?.kind !== "head";

  const [choices, setChoices] = useState<ComparisonChoice[]>([]);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [historicalPath, setHistoricalPath] = useState<string | null>(null);

  const comparisonRequest = useMemo<ComparisonRequest>(
    () => ({ base, target, merge_base: wholeBranch }),
    [base, target, wholeBranch]
  );

  const endpointKey = (endpoint: ComparisonEndpoint) =>
    endpoint.kind === "head"
      ? "head"
      : endpoint.kind === "working_tree"
        ? "working"
        : JSON.stringify(endpoint);

  const endpointFor = (value: string): ComparisonEndpoint | undefined =>
    value === "head"
      ? { kind: "head" }
      : value === "working"
        ? { kind: "working_tree" }
        : choices.find((choice) => endpointKey(choice.endpoint) === value)
            ?.endpoint;

  const historical = comparisonRequest.target.kind !== "working_tree";

  const resize = useSidebarResize();

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

  useEffect(() => {
    let current = true;

    setChoicesError(null);

    commands
      .listComparisonChoices(worktreePath)
      .then((result) => {
        if (!current) return;

        if (result.status === "ok") setChoices(result.data);
        else setChoicesError(result.error.message);
      })
      .catch((error: unknown) => {
        if (current) setChoicesError(String(error));
      });

    return () => {
      current = false;
    };
  }, [worktreePath, refresh.count]);

  const requestLoad = useRef<(() => void) | null>(null);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;

  useEffect(() => {
    let current = true;
    let running = false;
    let pending = false;
    const controller = new AbortController();

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
            comparisonRequest
          );
          if (!current) break;

          if (result.status === "error") {
            setState({ status: "error", message: result.error.message });
          } else {
            const task: Extract<BackgroundTask, { kind: "patch" }> = {
              kind: "patch",
              patches: result.data.files.map((file) =>
                file.marker ? "" : file.patch
              ),
              review: true,
            };

            const parsed =
              typeof Worker === "undefined"
                ? (
                    await import("../thread/toolChange/preparePatches")
                  ).preparePatches(task)
                : await backgroundClient.run(task, controller.signal);
            if (!current) break;

            setBaseBranch(result.data.base_branch);
            setState({
              status: "ready",
              data: result.data,
              wholeBranch,
              parsed,
            });
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
      controller.abort();
      requestLoad.current = null;
    };
  }, [worktreePath, wholeBranch, comparisonRequest]);

  useEffect(() => {
    requestLoad.current?.();
  }, [worktreePath, wholeBranch, comparisonRequest, refresh]);

  const onChangesLoadedRef = useRef(onChangesLoaded);
  onChangesLoadedRef.current = onChangesLoaded;

  useEffect(() => {
    if (state.status !== "ready") return;

    onChangesLoadedRef.current?.({
      wholeBranch: state.wholeBranch,
      comparisonIdentity: JSON.stringify(state.data.comparison),
      files: state.parsed.flatMap((file) => file.reviewFiles),
    });
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
        ? state.data.files.map((item) => ({ ...item, summary: item.totals }))
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
    if (historical) setHistoricalPath(path);
    else openDocument(worktreePath, path, view);
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
      if (!historical && activeDocument) save(activeDocument);
    }
  };

  const changesBody =
    state.status === "loading" ? (
      <p role="status">Loading changes…</p>
    ) : state.status === "error" ? (
      <p role="alert">{state.message}</p>
    ) : files.length === 0 ? (
      <div
        role="status"
        aria-label="No changes"
        className="flex flex-1 items-center justify-center text-[var(--color-fg-mute)]"
      >
        <p>No changes against this baseline.</p>
      </div>
    ) : (
      <div aria-label="All file diffs" className="changes-viewport">
        <Suspense fallback={<p role="status">Loading diffs…</p>}>
          <AllChangesView
            files={state.data.files}
            parsedPatches={state.parsed}
            jumpTarget={jumpTarget}
            onOpen={(path) => open(path, "diff")}
            diffStyle={diffStyle}
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
        <div className="changes-comparison-controls">
          <label>
            Base
            <ComparisonSelect
              label="Comparison base"
              value={base ? endpointKey(base) : "auto"}
              onChange={(value) => {
                const endpoint = value === "auto" ? null : endpointFor(value);

                if (endpoint !== undefined) {
                  setBase(endpoint);
                  setRefresh((value) => ({
                    count: value.count + 1,
                    background: false,
                  }));
                }
              }}
              options={[
                {
                  value: "auto",
                  label: baseBranch
                    ? `${baseBranch.replace(/^refs\/(heads|remotes)\//, "")} (default)`
                    : "Default branch",
                },
                { value: "head", label: "HEAD (current commit)" },
                ...choices.map((choice) => ({
                  value: JSON.stringify(choice.endpoint),
                  label: choice.label.replace(/^refs\/(heads|remotes)\//, ""),
                })),
              ]}
            />
          </label>
          <label>
            Compare
            <ComparisonSelect
              label="Comparison target"
              value={endpointKey(target)}
              onChange={(value) => {
                const endpoint = endpointFor(value);

                if (endpoint) {
                  setTarget(endpoint);
                  setHistoricalPath(null);
                  setMode("changes");
                  setRefresh((value) => ({
                    count: value.count + 1,
                    background: false,
                  }));
                }
              }}
              options={[
                { value: "working", label: "Working tree (current changes)" },
                { value: "head", label: "HEAD (current commit)" },
                ...choices.map((choice) => ({
                  value: JSON.stringify(choice.endpoint),
                  label: choice.label.replace(/^refs\/(heads|remotes)\//, ""),
                })),
              ]}
            />
          </label>
        </div>
        <div role="group" aria-label="Diff layout" className="document-views">
          {(["unified", "split"] as const).map((style) => (
            <button
              key={style}
              type="button"
              aria-pressed={diffStyle === style}
              onClick={() => setDiffStyle(style)}
            >
              {style === "unified" ? "Unified" : "Split"}
            </button>
          ))}
        </div>
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
      {choicesError && (
        <p role="status">
          Comparison choices unavailable: {choicesError}. Refresh to retry.
        </p>
      )}
      {state.status === "ready" && (
        <div className="changes-summary" role="status">
          <div className="changes-totals" aria-label="Comparison totals">
            <span className="changes-total-files">
              {files.length}{" "}
              <span>{files.length === 1 ? "file" : "files"}</span>
            </span>
            <span className="changes-total-added">
              +{state.data.totals.additions}
            </span>
            <span className="changes-total-deleted">
              −{state.data.totals.deletions}
            </span>
            {state.data.totals.binary_files > 0 && (
              <span className="changes-total-binary">
                {state.data.totals.binary_files} binary
              </span>
            )}
          </div>
          <span className="changes-summary-note">
            {state.data.comparison.working_tree
              ? "Includes active working tree: staged, unstaged and untracked"
              : "Committed contents only · read-only · linked worktree dirty files excluded"}
          </span>
        </div>
      )}
      {watchError && (
        <p role="status">
          Automatic refresh unavailable: {watchError}. Use Refresh to update.
        </p>
      )}
      {state.status === "ready" && state.data.base_unavailable && (
        <p role="status">{state.data.base_unavailable}</p>
      )}
      <div
        ref={resize.containerRef}
        className="changes-workspace flex min-h-0 flex-1"
      >
        <aside
          className={`changes-files-panel${filesOpen ? "" : " is-collapsed"}`}
          style={{ flexBasis: filesOpen ? resize.width : 36 }}
        >
          <div className="changes-files-header">
            {filesOpen && (
              <div
                role="group"
                aria-label="Sidebar mode"
                className="changes-modes workspace-tabs"
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
                  disabled={historical}
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
                            {item.totals.binary_files === 0 && (
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
                            title="Open"
                            onClick={() => open(item.path, "diff")}
                          >
                            Open
                          </button>
                        </li>
                      );
                    })}
                  </ul>
                </nav>
              )}
              <div
                hidden={mode !== "files" || historical}
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
        {filesOpen && (
          <div {...resize.handleProps} className="changes-resize-handle" />
        )}
        <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
          <nav
            aria-label="Open documents"
            className="changes-tabs workspace-tabs"
          >
            <button
              type="button"
              className="changes-tab"
              aria-current={
                (historical ? historicalPath == null : activeDocument == null)
                  ? "page"
                  : undefined
              }
              onClick={() => {
                activate(worktreePath, null);
                setHistoricalPath(null);
              }}
            >
              All changes
            </button>
            {!historical &&
              order.map((path) => (
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
          {historical && historicalPath && state.status === "ready" ? (
            <HistoricalDocument
              key={`${historicalPath}:${state.data.comparison.base_commit}:${state.data.comparison.target_commit}`}
              worktreePath={worktreePath}
              path={historicalPath}
              change={state.data.files.find(
                (file) => file.path === historicalPath
              )}
              comparison={state.data.comparison}
              diffStyle={diffStyle}
            />
          ) : historical || activeDocument == null ? (
            changesBody
          ) : (
            <DocumentPane
              key={activeDocument}
              worktreePath={worktreePath}
              path={activeDocument}
              change={files.find((file) => file.path === activeDocument)}
              baselineCommit={
                state.status === "ready"
                  ? state.data.comparison.base_commit
                  : null
              }
              changesGeneration={generation}
              diffStyle={diffStyle}
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
