import {
  lazy,
  Suspense,
  useEffect,
  useMemo,
  useState,
  useRef,
  useId,
} from "react";
import { commands, type WorktreeChanges as Changes } from "../../bindings";
import {
  countPatchLines,
  MARKER_TEXT,
} from "../thread/toolChange/worktreeDelta";

import { Select } from "../atoms/Select";
import { preloadDiffRenderer } from "../thread/toolChange/useWorktreeDelta";
import "./worktreeChanges.css";

const PatchFiles = lazy(() => import("../thread/toolChange/PatchFiles"));

type LoadState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; data: Changes };

/** Mounted only while open; retiring a request stops UI interest, not Git. */
export function WorktreeChanges({ worktreePath }: { worktreePath: string }) {
  const [wholeBranch, setWholeBranch] = useState(false);
  const [revision, setRevision] = useState(0);
  const [state, setState] = useState<LoadState>({ status: "loading" });
  const [filesOpen, setFilesOpen] = useState(true);
  const [activePath, setActivePath] = useState<string | null>(null);
  const fileListId = useId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const fileRefs = useRef(new Map<string, HTMLElement>());
  const [baseBranch, setBaseBranch] = useState<string | null>(null);

  // Warm Pierre and its highlight workers while Git computes the changes.
  useEffect(preloadDiffRenderer, []);
  useEffect(() => {
    let current = true;
    setState({ status: "loading" });
    void commands.loadWorktreeChanges(worktreePath, wholeBranch).then(
      (result) => {
        if (!current) return;
        if (result.status === "error") {
          setState({ status: "error", message: result.error.message });
        } else {
          setBaseBranch(result.data.base_branch);
          setState({ status: "ready", data: result.data });
        }
      },
      (error: unknown) => {
        if (current) setState({ status: "error", message: String(error) });
      }
    );
    return () => {
      current = false;
    };
  }, [worktreePath, wholeBranch, revision]);

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
            return {
              ...item,
              summary: {
                path: item.path,
                oldPath: item.old_path ?? undefined,
                status: item.status,
                marker: item.marker ?? undefined,
                ...(item.marker ? {} : counts),
              },
            };
          })
        : [],
    [state]
  );
  const jumpToFile = (path: string) => {
    setActivePath(path);
    const target = fileRefs.current.get(path);
    const viewport = viewportRef.current;
    if (target && viewport)
      viewport.scrollTo({ top: target.offsetTop, behavior: "auto" });
  };

  return (
    <section
      aria-label="Worktree changes"
      className="flex min-h-0 flex-1 flex-col gap-2 p-3 text-sm"
    >
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-0 flex-1 items-center gap-2 text-xs text-[var(--color-fg-mute)]">
          Baseline
          <Select
            aria-label="Changes baseline"
            value={wholeBranch ? "branch" : "head"}
            onChange={(event) =>
              setWholeBranch(event.target.value === "branch")
            }
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
          onClick={() => setRevision((value) => value + 1)}
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
      {state.status === "loading" && <p role="status">Loading changes…</p>}
      {state.status === "error" && <p role="alert">{state.message}</p>}
      {state.status === "ready" && (
        <>
          {state.data.base_unavailable && (
            <p role="status">{state.data.base_unavailable}</p>
          )}
          {files.length === 0 ? (
            <p>No changes against this baseline.</p>
          ) : (
            <div className="flex min-h-0 flex-1 gap-3">
              <aside
                className={`changes-files-panel${filesOpen ? "" : " is-collapsed"}`}
              >
                <div className="changes-files-header">
                  {filesOpen && (
                    <span className="changes-files-title">
                      Files{" "}
                      <span className="changes-files-count">
                        {files.length}
                      </span>
                    </span>
                  )}
                  <button
                    type="button"
                    className="changes-files-toggle"
                    aria-label={filesOpen ? "Hide files" : "Show files"}
                    title={
                      filesOpen ? "Collapse file list" : "Expand file list"
                    }
                    aria-expanded={filesOpen}
                    aria-controls={filesOpen ? fileListId : undefined}
                    onClick={() => setFilesOpen((open) => !open)}
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
                  <nav
                    id={fileListId}
                    aria-label="Changed files"
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
                          <li key={item.path}>
                            <button
                              type="button"
                              className="changes-file-row"
                              aria-label={`Jump to ${item.path}`}
                              aria-current={
                                activePath === item.path
                                  ? "location"
                                  : undefined
                              }
                              title={label}
                              onClick={() => jumpToFile(item.path)}
                            >
                              <span
                                className={`changes-file-status is-${item.status}`}
                                title={item.status}
                              >
                                {
                                  {
                                    added: "A",
                                    modified: "M",
                                    deleted: "D",
                                    renamed: "R",
                                  }[item.status]
                                }
                              </span>
                              <span className="changes-file-path">
                                <span className="changes-file-name">
                                  {name}
                                </span>
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
                          </li>
                        );
                      })}
                    </ul>
                  </nav>
                )}
              </aside>
              <div
                ref={viewportRef}
                aria-label="All file diffs"
                className="relative min-h-0 min-w-0 flex-1 overflow-auto"
              >
                {files.map((file) => (
                  <section
                    key={file.path}
                    aria-label={`Diff for ${file.path}`}
                    className="mb-6"
                    ref={(element) => {
                      if (element) fileRefs.current.set(file.path, element);
                      else fileRefs.current.delete(file.path);
                    }}
                  >
                    {file.marker ? (
                      <p className="changes-file-fallback">
                        <span className="font-mono">{file.path}</span>
                        <span>{MARKER_TEXT[file.marker]}</span>
                      </p>
                    ) : file.patch ? (
                      <Suspense fallback={<p role="status">Loading diff…</p>}>
                        <PatchFiles patch={file.patch} />
                      </Suspense>
                    ) : (
                      <p className="changes-file-fallback">
                        <span className="font-mono">{file.path}</span>
                        <span>No text hunks (mode or metadata change).</span>
                      </p>
                    )}
                  </section>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </section>
  );
}
