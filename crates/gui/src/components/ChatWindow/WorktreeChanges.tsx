import {
  TurnDocument,
  type TurnDocumentTarget,
  type TurnDocumentVersion,
} from "./workspace/TurnDocument";
import { flushSync } from "react-dom";
import { useOpenLocalFile } from "../../hooks/useOpenLocalFile";
import { SelectionDiscussionContext } from "./selectionDiscussionState";
import { CHAT_AREA_ATTRIBUTE } from "./chatAreas";
import { contextScope, usePaletteScope } from "../CommandPalette/paletteScopes";
import { DIFF_CURSOR_HOST_ATTRIBUTE } from "../thread/toolChange/diffCursor";
import { OpenInExternalEditor } from "./workspace/OpenInExternalEditor";

import {
  lazy,
  Suspense,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useId,
  type KeyboardEvent,
  type Ref,
} from "react";
import type {
  FileStatus,
  ComparisonRequest,
  ComparisonEndpoint,
  WorktreeChange,
} from "../../bindings";
import { usePierreDiffOptions } from "../../hooks/useCodeAppearance";
import { useSidebarResize } from "./workspace/useSidebarResize";
import { HistoricalDocument } from "./workspace/HistoricalDocument";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";

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
import { UnsavedChangesDialog } from "./workspace/UnsavedChangesDialog";
import type { JumpTarget } from "./workspace/AllChangesView";
import {
  useChangesCursor,
  useChangesView,
  useChatSideColumnStore,
} from "../../stores/chatSideColumnStore";
import {
  loadChangeSides,
  loadChangedSymbols,
  sharedChangedSymbols,
} from "./workspace/changeContents";
import { routeSource, type FileReveal } from "./workspace/sourceRoute";
import { ChangedFilesList } from "./workspace/ChangedFilesList";
import { ChangesSummary } from "./workspace/ChangesSummary";
import { SideEmptyState } from "./SideEmptyState";
import { CodeGlyph } from "./commentIcons";
import { ComparisonControls } from "./workspace/ComparisonControls";
import {
  PrAssociationBar,
  type PrBarHandle,
} from "./workspace/PrAssociationBar";
import { useWorktreePr } from "../../hooks/useWorktreePr";
import { ReviewRail } from "./workspace/githubReview/ReviewRail";
import {
  stepOrigin,
  useThreadRevealRequests,
  useWorktreeReview,
} from "./workspace/githubReview/useWorktreeReview";
import type { ViewportAnchor } from "./workspace/viewportAnchor";
import { OpenDocumentTabs } from "./workspace/OpenDocumentTabs";
import {
  changesPaletteItems,
  openFilesPalette,
} from "./workspace/changesPalette";
import { handleChangesKeyDown } from "./workspace/changesKeys";
import { useComparisonChoices } from "./workspace/useComparisonChoices";
import { useViewedPaths } from "./workspace/useViewedPaths";
import {
  useWorktreeChangesLoad,
  type ChangesRefresh,
} from "./workspace/useWorktreeChangesLoad";
import "./workspaceTabs.css";
import "./worktreeChanges.css";

const AllChangesView = lazy(() => import("./workspace/AllChangesView"));

const NO_PATHS: readonly string[] = [];
const NO_FILES: readonly WorktreeChange[] = [];

type SidebarMode = "changes" | "files";

/**
 * Jump nonces, each jump handled once: references count up from 1, jumps
 * made inside Changes down from -1, and 0 restores a remounted view's file.
 */
const RESTORE_JUMP_NONCE = 0;

/** Focus the diff's line cursor inside `section`; false if none yet. */
function resumeLineCursor(section: HTMLElement): boolean {
  const cursor = section.querySelector<HTMLElement>(
    `[${DIFF_CURSOR_HOST_ATTRIBUTE}]`
  );
  cursor?.focus({ preventScroll: true });
  return !!cursor;
}

/**
 * The worktree workspace: Git changes and a file browser in the sidebar,
 * every change in one virtualized viewport, and open documents edited as
 * files or diffs. Documents hold the file as read; the lists refresh after a
 * save, on request, or after filesystem notifications. Drafts survive
 * unmounting in the per-worktree store.
 */
export function WorktreeChanges({
  ref,
  worktreePath,
  onChangesLoaded,
  sourceJump,
  turnDocument: shownTurn,
  onTurnDismiss,
  onTurnVersionChange,
  onExit,
  sessionId,
  prBranch = null,
}: {
  ref?: Ref<HTMLElement>;
  /**
   * The chat whose Changes this is: the comparison, active file and line
   * cursor live in its side column store, so a remount finds them in place.
   */
  sessionId: string;
  /** Hand focus back to the chat input (Esc from the line cursor). */
  onExit?(): void;
  worktreePath: string;
  /**
   * Branch whose GitHub PR the bar shows: the chat's pinned branch when this
   * is the chat's own worktree. Null shows no PR bar (the checkout's HEAD is
   * never used).
   */
  prBranch?: string | null;
  sourceJump?: JumpTarget | null;
  turnDocument?: {
    nonce: number;
    target: TurnDocumentTarget;
    version: TurnDocumentVersion;
  } | null;
  onTurnDismiss?(nonce: number): void;
  onTurnVersionChange?(nonce: number, version: TurnDocumentVersion): void;
  /** Called with the parsed All Changes patch after every successful load. */
  onChangesLoaded?: (snapshot: WorktreeSnapshot) => void;
}) {
  const baseButton = useRef<HTMLButtonElement>(null);
  const targetButton = useRef<HTMLButtonElement>(null);
  const prBar = useRef<PrBarHandle>(null);
  const worktreePr = useWorktreePr(prBranch ? worktreePath : null, prBranch);
  const fileList = useRef<HTMLElement>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const [fileCursorRequest, setFileCursorRequest] = useState<{
    path: string;
    focus(cursor: HTMLElement): void;
  } | null>(null);
  const requestFileCursor = useCallback((path: string) => {
    const origin = document.activeElement;
    let pending = true;
    setFileCursorRequest({
      path,
      focus(cursor) {
        if (!pending) return;
        pending = false;
        const active = cursor.ownerDocument.activeElement;
        // The file can finish loading after the user has moved elsewhere.
        if (
          active === origin ||
          active === sectionRef.current ||
          active === cursor.ownerDocument.body
        )
          cursor.focus({ preventScroll: true });
      },
    });
  }, []);
  const discussion = useContext(SelectionDiscussionContext);
  const changesKey = useMemo(
    () => ({ sessionId, worktreePath }),
    [sessionId, worktreePath]
  );
  const { base, target, activePath, reviewOpen } = useChangesView(changesKey);
  const [lineCursor] = useChangesCursor(changesKey);
  const saveChanges = useChatSideColumnStore((state) => state.saveChanges);
  const saveView = useCallback(
    (patch: Parameters<typeof saveChanges>[2]) =>
      saveChanges(sessionId, worktreePath, patch),
    [saveChanges, sessionId, worktreePath]
  );
  const setBase = (base: ComparisonEndpoint | null) => saveView({ base });
  const setTarget = (target: ComparisonEndpoint) => saveView({ target });
  const setActivePath = useCallback(
    (activePath: string | null) => saveView({ activePath }),
    [saveView]
  );

  const preferredDiffOptions = usePierreDiffOptions();
  const [diffStyle, setDiffStyle] = useState(preferredDiffOptions.diffStyle);
  const wholeBranch = base?.kind !== "head";

  const [historicalDocument, setHistoricalDocument] = useState<{
    path: string;
    view: "diff" | "file";
  } | null>(null);
  const historicalPath = historicalDocument?.path ?? null;

  const comparisonRequest = useMemo<ComparisonRequest>(
    () => ({ base, target, merge_base: wholeBranch }),
    [base, target, wholeBranch]
  );

  const historical = comparisonRequest.target.kind !== "working_tree";

  // A narrow file list leaves the width to the diff.
  const resize = useSidebarResize({ initial: 200 });

  // Background refreshes keep the current list visible while Git runs.
  const [refresh, setRefresh] = useState<ChangesRefresh>({
    count: 0,
    background: false,
  });
  const reload = (background: boolean) =>
    setRefresh((value) => ({ count: value.count + 1, background }));
  const { state, generation, baseBranch } = useWorktreeChangesLoad(
    worktreePath,
    comparisonRequest,
    refresh,
    onChangesLoaded
  );
  // Changes entered before its diff loaded: the cursor takes the keys once
  // the diff is there, unless focus has moved on meanwhile.
  const diffReady = state.status === "ready";
  useEffect(() => {
    const section = sectionRef.current;
    if (diffReady && section && section.ownerDocument.activeElement === section)
      resumeLineCursor(section);
  }, [diffReady]);
  const [filesOpen, setFilesOpen] = useState(true);
  const [mode, setMode] = useState<SidebarMode>("changes");
  // Back on Changes: scroll to the file the chat left it on.
  const [jumpTarget, setJumpTarget] = useState<JumpTarget | null>(() =>
    activePath ? { path: activePath, nonce: RESTORE_JUMP_NONCE } : null
  );
  // A reference's lines: scrolled to once, highlighted until the first edit
  // or manual navigation.
  const [reveal, setReveal] = useState<
    (FileReveal & { scrolled: boolean }) | null
  >(null);
  // An external reference waiting for a working-tree comparison to route on.
  const [pendingSource, setPendingSource] = useState<JumpTarget | null>(null);
  const dismissTurn = () => {
    if (shownTurn) onTurnDismiss?.(shownTurn.nonce);
  };
  const turnNonce = shownTurn?.nonce;
  useEffect(() => {
    if (turnNonce === undefined) return;
    setFilesOpen(false);
    setPendingSource(null);
  }, [turnNonce]);
  useEffect(() => {
    if (!sourceJump) return;
    // References name the working copy and open beside a collapsed explorer.
    setFilesOpen(false);
    setHistoricalDocument(null);
    saveView((current) =>
      current.target.kind === "working_tree"
        ? {}
        : { target: { kind: "working_tree" } }
    );
    setPendingSource(sourceJump);
  }, [sourceJump, saveView]);
  // Route only on a working-copy result: a ready or failed past-commit load
  // may still be shown while the working copy loads. A failed working-copy
  // load still opens the referenced file.
  const sourceRoute =
    shownTurn || !pendingSource
      ? null
      : state.status === "ready" && state.data.comparison.working_tree
        ? routeSource(pendingSource, state.data.files, state.parsed)
        : state.status === "error" && state.workingTree
          ? routeSource(pendingSource, [], [])
          : null;
  // The route is derived during render, but applying it consumes the one-off
  // request and moves the workspace (active document, jump, reveal), so it is
  // committed once in an effect rather than re-derived on later renders.
  useEffect(() => {
    if (!sourceRoute) return;
    setPendingSource(null);
    if (sourceRoute.view === "diff") {
      setActivePath(sourceRoute.target.path);
      setReveal(null);
      activate(worktreePath, null);
      setJumpTarget(sourceRoute.target);
    } else {
      setActivePath(sourceRoute.path);
      setJumpTarget(null);
      // An open document keeps its draft; only its view changes.
      openDocument(worktreePath, sourceRoute.path, "file");
      setReveal(
        sourceRoute.reveal && { ...sourceRoute.reveal, scrolled: false }
      );
    }
  }, [sourceRoute, worktreePath, setActivePath]);
  // Publish a routed diff in this render, before switching from an open
  // document can mount the viewport with the previous request.
  const effectiveJumpTarget =
    sourceRoute?.view === "diff" ? sourceRoute.target : jumpTarget;
  const [treeToken, setTreeToken] = useState(0);
  const [closing, setClosing] = useState<string | null>(null);
  const [closeBusy, setCloseBusy] = useState(false);
  const fileListId = useId();

  // Narrow selections: typing in a draft must not re-render the workspace.
  const order = useDocumentStore(
    (store) => store.workspaces[worktreePath]?.order ?? NO_PATHS
  );
  const activeDocument = useDocumentStore(
    (store) => store.workspaces[worktreePath]?.active ?? null
  );
  const showingChanges =
    !shownTurn &&
    (historical ? historicalPath == null : activeDocument == null);
  const dirtyKey = useDocumentStore((store) => {
    const workspace = store.workspaces[worktreePath];

    return (workspace?.order ?? NO_PATHS)
      .filter((path) => isDirty(workspace?.documents[path]))
      .join("\n");
  });
  const dirty = useMemo(() => new Set(dirtyKey.split("\n")), [dirtyKey]);

  // Warm Pierre and its highlight workers while Git computes the changes.
  useEffect(preloadDiffRenderer, []);

  const comparisonChoices = useComparisonChoices(worktreePath, refresh.count);

  const comparison = state.status === "ready" ? state.data.comparison : null;
  // Both sides of a change, so Changes can reveal its unchanged lines, and
  // in semantic mode its semantic diff.
  const loadSides = useMemo(
    () =>
      comparison
        ? (change: WorktreeChange, semantic: boolean) =>
            loadChangeSides(worktreePath, comparison, change, semantic)
        : undefined,
    [worktreePath, comparison]
  );

  const comparisonFiles = state.status === "ready" ? state.data.files : null;
  // The comparison's changed symbols, loaded once per comparison.
  const symbolGraphRequest = useMemo(() => {
    if (!comparison || !comparisonFiles) return undefined;
    // Background refreshes may return a fresh copy of the same comparison.
    // Reuse graph results until an endpoint or its working-tree patch changes.
    const patches = comparison.working_tree
      ? comparisonFiles.map(({ path, old_path, patch, marker }) => [
          path,
          old_path,
          patch,
          marker,
        ])
      : null;
    const key = JSON.stringify([worktreePath, comparison, patches]);
    return {
      key,
      load: () =>
        sharedChangedSymbols(key, () =>
          loadChangedSymbols(worktreePath, comparison, comparisonFiles)
        ),
    };
  }, [worktreePath, comparison, comparisonFiles]);

  const refreshAll = useCallback(() => {
    setRefresh((value) => ({ count: value.count + 1, background: true }));
    setTreeToken((value) => value + 1);
  }, []);

  const watchError = useWorktreeWatch(worktreePath, refreshAll);

  useEffect(() => () => releaseCleanDocuments(worktreePath), [worktreePath]);

  const files = state.status === "ready" ? state.data.files : NO_FILES;
  const statuses = useMemo(
    () =>
      new Map<string, FileStatus>(
        files.map((file) => [file.path, file.status])
      ),
    [files]
  );
  const parsedPatches = state.status === "ready" ? state.parsed : null;
  const hunksByFile = useMemo(
    () =>
      files.map((_, index) =>
        (parsedPatches?.[index]?.files ?? []).flatMap((diff) => diff.hunks)
      ),
    [files, parsedPatches]
  );
  const viewport = useRef<(() => ViewportAnchor | null) | null>(null);

  const { viewedPaths, setViewed } = useViewedPaths(
    JSON.stringify([worktreePath, comparisonRequest]),
    statuses
  );

  const selectedFile =
    files.find((file) => file.path === activePath) ?? files[0];
  const external = useOpenLocalFile(
    worktreePath,
    selectedFile?.path ?? "",
    null,
    null
  );

  const nextLocalJump = useRef(0);
  /**
   * A new comparison remounts the diff: bring it back to the line at the top
   * of the view (else the line cursor, else the active file) rather than to
   * the top or an older jump.
   */
  const keepPlace = () => {
    const shown = viewport.current?.();
    if (shown) {
      setJumpTarget({ ...shown, nonce: --nextLocalJump.current, keep: true });
      return;
    }
    const memory =
      useChatSideColumnStore.getState().bySession[sessionId]?.changes[
        worktreePath
      ];
    const cursor = memory?.cursor;
    const path = cursor?.path ?? activePath;
    if (!path) return;
    const side = cursor?.range.endSide ?? cursor?.range.side;
    setJumpTarget({
      path,
      nonce: --nextLocalJump.current,
      ...(cursor
        ? { line: cursor.range.end, side: side === "deletions" ? "old" : "new" }
        : {}),
    });
  };
  // Navigating by hand drops a reference's revealed lines.
  /** ⇧V: the file most recently marked viewed comes back, under the cursor. */
  const unviewLast = () => {
    const last = [...viewedPaths].at(-1);
    if (!last) return;
    setViewed(last, false);
    jumpToFile(last, true);
  };

  const jumpToFile = (
    path: string,
    focusHeader = false,
    location?: Pick<JumpTarget, "line" | "side">
  ) => {
    dismissTurn();
    setReveal(null);
    setActivePath(path);
    activate(worktreePath, null);
    setHistoricalDocument(null);
    setJumpTarget({
      ...location,
      path,
      nonce: --nextLocalJump.current,
      focusHeader,
    });
  };

  const review = useWorktreeReview({
    worktreePath,
    prBranch,
    pr: worktreePr,
    comparison,
    generation,
    files,
    hunksByFile,
    reviewOpen,
    setReviewOpen: (open) => saveView({ reviewOpen: open }),
    pane: sectionRef,
    filesOpen,
    hideFiles: () => setFilesOpen(false),
    jumpToFile,
  });

  useThreadRevealRequests(review, discussion);

  const open = (path: string, view: "file" | "diff") => {
    dismissTurn();
    setReveal(null);
    setActivePath(path);
    if (historical) setHistoricalDocument({ path, view });
    else {
      if (view === "file") requestFileCursor(path);
      openDocument(worktreePath, path, view);
    }
  };

  const save = (path: string) =>
    void saveDocument(worktreePath, path).then((saved) => {
      if (saved) refreshAll();
    });

  const requestClose = (path: string) => {
    if (isDirty(documentOf(worktreePath, path))) setClosing(path);
    else closeDocument(worktreePath, path);
  };

  const moveFile = (direction: -1 | 1) => {
    if (!files.length) return;
    const current = files.findIndex((file) => file.path === activePath);
    const index =
      current < 0
        ? direction === 1
          ? 0
          : files.length - 1
        : (current + direction + files.length) % files.length;
    jumpToFile(files[index].path, true);
  };

  const focusFileList = () => {
    flushSync(() => {
      setMode("changes");
      setFilesOpen(true);
    });
    const list = fileList.current;
    (
      list?.querySelector<HTMLButtonElement>('[aria-current="location"]') ??
      list?.querySelector<HTMLButtonElement>("button") ??
      list
    )?.focus();
  };

  /** Return focus to Changes; entering resumes the line cursor. */
  const refocus = () => {
    requestAnimationFrame(() =>
      sectionRef.current?.focus({ preventScroll: true })
    );
  };

  const openSelected = (view: "file" | "diff") => {
    if (!selectedFile) return;
    // Opening the document removes the focused diff heading.
    sectionRef.current?.focus({ preventScroll: true });
    open(selectedFile.path, view);
  };

  usePaletteScope(sectionRef, () => [
    contextScope(
      "changes",
      changesPaletteItems(
        {
          files,
          selectedPath: selectedFile?.path ?? null,
          viewedPaths,
          filesOpen,
          diffStyle,
          discussion,
          baseButton: baseButton.current,
          targetButton: targetButton.current,
          pr: prBranch ? worktreePr : null,
          prBar: prBar.current,
          review: review.review ?? null,
        },
        {
          jumpToFile,
          moveFile,
          setViewed,
          focusFileList,
          hideFiles: () => setFilesOpen(false),
          openSelected,
          openExternal: () => void external.open(),
          setDiffStyle,
          refresh: refreshAll,
          refocus,
          // A stepped-to card takes focus itself; a deferred refocus would
          // take it back, so the pane refocuses only when nothing opened.
          stepThread: (direction) => {
            if (!review.stepThreads(null, direction)) refocus();
          },
        }
      )
    ),
  ]);

  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) =>
    handleChangesKeyDown(event, {
      blocked: closing != null,
      save: () => {
        if (!shownTurn && !historical && activeDocument) save(activeDocument);
      },
      findFile: openFilesPalette,
      moveFile,
      unviewLast,
      fileList: fileList.current,
      toggleViewed: selectedFile
        ? () =>
            setViewed(selectedFile.path, !viewedPaths.has(selectedFile.path))
        : null,
      toggleReview: review.review?.onToggle ?? null,
      stepThread: review.review
        ? (origin, direction) => {
            review.stepThreads(stepOrigin(origin, lineCursor), direction);
          }
        : null,
    });

  // Loading, failure and an empty comparison share the side column's
  // empty-state pattern.
  const changesBody =
    state.status === "loading" ? (
      <SideEmptyState
        icon={<CodeGlyph />}
        message={<span role="status">Loading changes…</span>}
      />
    ) : state.status === "error" ? (
      <SideEmptyState
        icon={<CodeGlyph />}
        message={<span role="alert">{state.message}</span>}
        hint="Refresh to try again."
      />
    ) : files.length === 0 ? (
      <div role="status" aria-label="No changes" className="changes-empty">
        <SideEmptyState
          icon={<CodeGlyph />}
          message="No changes against this baseline."
        />
      </div>
    ) : (
      <div aria-label="All file diffs" className="changes-viewport">
        <Suspense
          fallback={
            <p role="status" className="changes-notice">
              Loading diffs…
            </p>
          }
        >
          <AllChangesView
            key={JSON.stringify([worktreePath, comparisonRequest])}
            files={state.data.files}
            parsedPatches={state.parsed}
            jumpTarget={effectiveJumpTarget}
            onOpen={(path) => open(path, "diff")}
            renderExternalEditor={(path) => (
              <OpenInExternalEditor
                root={worktreePath}
                path={path}
                line={
                  effectiveJumpTarget?.path === path
                    ? effectiveJumpTarget.line
                    : undefined
                }
                column={
                  effectiveJumpTarget?.path === path
                    ? effectiveJumpTarget.column
                    : undefined
                }
              />
            )}
            diffStyle={diffStyle}
            onCursorFile={setActivePath}
            chatChanges={changesKey}
            onExit={onExit}
            viewedPaths={viewedPaths}
            onViewedChange={setViewed}
            loadSides={loadSides}
            symbolGraphRequest={symbolGraphRequest}
            onRelatedJump={(location) =>
              jumpToFile(location.path, false, location)
            }
            github={review.diff}
            onLinesShown={review.onLinesShown}
            viewportRef={viewport}
          />
        </Suspense>
      </div>
    );

  return (
    <section
      ref={(node) => {
        sectionRef.current = node;
        if (typeof ref === "function") return ref(node);
        if (ref) ref.current = node;
      }}
      tabIndex={-1}
      aria-label="Worktree changes"
      {...{ [CHAT_AREA_ATTRIBUTE]: "changes" }}
      className="changes-keyboard-region flex min-h-0 flex-1 flex-col gap-2 p-3 text-content"
      onKeyDownCapture={onKeyDownCapture}
      onFocusCapture={(event) => {
        const section = event.currentTarget;
        if (
          event.target === section &&
          !(
            event.relatedTarget instanceof Node &&
            section.contains(event.relatedTarget)
          )
        ) {
          // Entering Changes resumes the line cursor where it was left.
          if (resumeLineCursor(section)) return;
        }
        if (!(event.target instanceof HTMLElement)) return;
        const path = event.target.closest<HTMLElement>("[data-changes-path]")
          ?.dataset.changesPath;
        if (path) setActivePath(path);
      }}
    >
      <ComparisonControls
        comparison={comparisonChoices}
        base={base}
        target={target}
        baseBranch={baseBranch}
        baseButton={baseButton}
        targetButton={targetButton}
        onBaseChange={(endpoint) => {
          setBase(endpoint);
          keepPlace();
          reload(false);
        }}
        onTargetChange={(endpoint) => {
          dismissTurn();
          setTarget(endpoint);
          setHistoricalDocument(null);
          setMode("changes");
          keepPlace();
          reload(false);
        }}
        diffStyle={diffStyle}
        onDiffStyleChange={setDiffStyle}
        refreshDisabled={state.status === "loading"}
        onRefresh={refreshAll}
      />
      {/* Band 2 (review bar) and band 3 (checks drawer) sit under the
          comparison toolbar. */}
      {prBranch && (
        <PrAssociationBar ref={prBar} pr={worktreePr} review={review.review} />
      )}
      {jumpTarget &&
        state.status === "ready" &&
        files.length > 0 &&
        !files.some((file) => file.path === jumpTarget.path) && (
          <p role="status" className="changes-notice">
            {jumpTarget.path} has no diff against this baseline. Choose another
            comparison to inspect its changes.
          </p>
        )}
      {comparisonChoices.error && (
        <p role="status" className="changes-notice">
          Comparison choices unavailable: {comparisonChoices.error}. Refresh to
          retry.
        </p>
      )}
      {state.status === "ready" && (
        <ChangesSummary data={state.data} viewedCount={viewedPaths.size} />
      )}
      {watchError && (
        <p role="status" className="changes-notice">
          Automatic refresh unavailable: {watchError}. Use Refresh to update.
        </p>
      )}
      {state.status === "ready" && state.data.base_unavailable && (
        <p role="status" className="changes-notice">
          {state.data.base_unavailable}
        </p>
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
              title={`${filesOpen ? "Collapse" : "Expand"} file list`}
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
              {mode === "changes" && (
                <ChangedFilesList
                  listRef={fileList}
                  files={files}
                  selectedPath={selectedFile?.path ?? null}
                  activePath={activePath}
                  onJump={(path) => jumpToFile(path)}
                />
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
          <OpenDocumentTabs
            showingChanges={showingChanges}
            documents={historical ? NO_PATHS : order}
            currentDocument={shownTurn ? null : activeDocument}
            dirty={dirty}
            onShowChanges={() => {
              dismissTurn();
              setReveal(null);
              activate(worktreePath, null);
              setHistoricalDocument(null);
            }}
            onActivate={(path) => {
              dismissTurn();
              setReveal(null);
              setActivePath(path);
              requestFileCursor(path);
              activate(worktreePath, path);
            }}
            onClose={requestClose}
          />
          {shownTurn ? (
            <TurnDocument
              key={shownTurn.nonce}
              target={shownTurn.target}
              version={shownTurn.version}
              onVersionChange={(version) =>
                onTurnVersionChange?.(shownTurn.nonce, version)
              }
              onClose={dismissTurn}
            />
          ) : historical && historicalDocument && state.status === "ready" ? (
            <HistoricalDocument
              key={`${historicalPath}:${state.data.comparison.base_commit}:${state.data.comparison.target_commit}`}
              worktreePath={worktreePath}
              path={historicalDocument.path}
              view={historicalDocument.view}
              onViewChange={(view) =>
                setHistoricalDocument({ path: historicalDocument.path, view })
              }
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
              reveal={reveal?.path === activeDocument ? reveal : null}
              onRevealed={() =>
                setReveal(
                  (current) => current && { ...current, scrolled: true }
                )
              }
              onEdited={() => setReveal(null)}
              onFileView={() => requestFileCursor(activeDocument)}
              focusCursor={
                fileCursorRequest?.path === activeDocument
                  ? fileCursorRequest.focus
                  : undefined
              }
              diffStyle={diffStyle}
              onSave={save}
              onSaved={refreshAll}
            />
          )}
        </div>
        {review.showRail && (
          <ReviewRail
            railRef={review.railRef}
            prNumber={review.placement.prNumber}
            model={review.placement.model}
            loading={review.placement.loading}
            error={review.placement.error}
            threads={review.rail}
            onClose={review.closeRail}
          />
        )}
      </div>
      {external.error && <p role="alert">{external.error}</p>}
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
