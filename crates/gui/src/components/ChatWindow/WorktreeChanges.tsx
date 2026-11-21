import {
  TurnDocument,
  type TurnDocumentTarget,
  type TurnDocumentVersion,
} from "./workspace/TurnDocument";
import { flushSync } from "react-dom";
import { useOpenLocalFile } from "../../hooks/useOpenLocalFile";
import { isEditableShortcutTarget } from "../../utils/keyboard";
import {
  CHANGED_FILE_LIST_KEYS,
  CHANGES_COMMANDS,
  CHANGES_UNVIEW_HINT,
  CHANGES_VIEWED_KEY,
  DISCUSSION_ASK_SHORTCUT,
  DISCUSSION_COLLAPSE_SHORTCUT,
  DISCUSSION_OPEN_KEY,
  DISCUSSION_SEND_SHORTCUT,
  shortcutText,
} from "./chatShortcuts";
import {
  SelectionDiscussionContext,
  type DiscussionValue,
} from "./selectionDiscussionState";
import { isOutdated, selectionLabel } from "./selectionDiscussions";
import { useChatStore } from "../../stores/chatStore";
import { useCommandPaletteStore } from "../../stores/commandPaletteStore";
import { CHAT_AREA_ATTRIBUTE } from "./chatAreas";
import {
  isPaletteShortcut,
  type PaletteItem,
} from "../CommandPalette/paletteModel";
import { DIFF_CURSOR_HOST_ATTRIBUTE } from "../thread/toolChange/diffCursor";
import { OpenInExternalEditor } from "./workspace/OpenInExternalEditor";
import { backgroundClient } from "../../background/client";
import type { BackgroundTask, BackgroundOutputs } from "../../background/types";

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
import {
  commands,
  type FileStatus,
  type ComparisonRequest,
  type ComparisonEndpoint,
  type ComparisonChoice,
  type WorktreeChange,
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
import {
  loadChangeSides,
  loadChangedSymbols,
  sharedChangedSymbols,
} from "./workspace/changeContents";
import { routeSource, type FileReveal } from "./workspace/sourceRoute";
import "./workspaceTabs.css";
import "./worktreeChanges.css";

const AllChangesView = lazy(() => import("./workspace/AllChangesView"));

const NO_PATHS: readonly string[] = [];

type LoadState =
  | { status: "loading" }
  | {
      status: "error";
      message: string;
      /** Whether the failed load compared against the working copy. */
      workingTree: boolean;
    }
  | {
      status: "ready";
      data: Changes;
      wholeBranch: boolean;
      parsed: BackgroundOutputs["patch"];
    };

type SidebarMode = "changes" | "files";

const NO_VIEWED: ReadonlySet<string> = new Set();

/**
 * Discussions in the ⌘K palette, each with the binding that does the same
 * from the diff: every action on the open discussion, then every other
 * discussion to open.
 */
function changesDiscussionItems(
  discussion: DiscussionValue | null,
  refocus: () => void
): PaletteItem[] {
  if (!discussion) return [];
  const active = discussion.threads.find(({ id }) => id === discussion.activeId);
  const activeItems: PaletteItem[] = [];
  if (active) {
    const hint = selectionLabel(active.anchor);
    const inline = active.status.kind === "inline";
    const readable = active.status.kind !== "unreadable";
    const item = (
      id: string,
      label: string,
      detail: string | undefined,
      keywords: string,
      run: () => void
    ): PaletteItem => ({
      id: `changes-discussion-${id}`,
      scope: "changes",
      label,
      hint,
      detail,
      keywords: `discussion ${keywords}`,
      run,
    });
    const session = active.sessionId
      ? useChatStore.getState().sessions[active.sessionId]
      : undefined;
    if (readable) {
      activeItems.push(
        item("ask", "Ask follow-up", shortcutText(DISCUSSION_ASK_SHORTCUT), "question composer", () =>
          discussion.reopen(active.id, { focus: true })
        ),
        item(
          "send",
          "Send selection to main chat",
          shortcutText(DISCUSSION_SEND_SHORTCUT),
          "attach",
          () => discussion.attach(active.anchor, isOutdated(active))
        )
      );
    }
    if (session?.activeTurn) {
      activeItems.push(
        item("stop", "Stop response", undefined, "cancel", () =>
          discussion.cancel(active.id)
        )
      );
    }
    activeItems.push(
      item(
        "collapse",
        discussion.collapsed.has(active.id)
          ? "Show all turns"
          : "Show only the latest response",
        shortcutText(DISCUSSION_COLLAPSE_SHORTCUT),
        "collapse expand earlier turns",
        () => discussion.toggleCollapsed(active.id)
      )
    );
    if (inline) {
      activeItems.push(
        item("highlight", "Highlight selected code", undefined, "select anchor", () =>
          discussion.select(active.anchor)
        )
      );
    }
    activeItems.push(
      item("close", "Close discussion", "Esc", "", () => {
        discussion.reopen(null);
        refocus();
      })
    );
  }
  const openItems: PaletteItem[] = discussion.threads
    .filter(({ id }) => id !== discussion.activeId)
    .map((thread) => ({
      id: `changes-discussion-open-${thread.id}`,
      scope: "changes",
      label: "Open discussion",
      hint: selectionLabel(thread.anchor),
      // `o` works on the anchor's line, which only an inline thread has.
      detail: thread.status.kind === "inline" ? DISCUSSION_OPEN_KEY : undefined,
      keywords: "discussion reopen thread",
      run: () => discussion.reopen(thread.id, { focus: true }),
    }));
  return [...activeItems, ...openItems];
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
}: {
  ref?: Ref<HTMLElement>;
  /** Hand focus back to the chat input (Esc from the line cursor). */
  onExit?(): void;
  worktreePath: string;
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
  const fileList = useRef<HTMLElement>(null);
  const sectionRef = useRef<HTMLElement | null>(null);
  const openPalette = useCommandPaletteStore((state) => state.openPalette);
  const discussion = useContext(SelectionDiscussionContext);
  const [base, setBase] = useState<ComparisonEndpoint | null>(null);
  const [target, setTarget] = useState<ComparisonEndpoint>({
    kind: "working_tree",
  });
  const preferredDiffOptions = usePierreDiffOptions();
  const [diffStyle, setDiffStyle] = useState(preferredDiffOptions.diffStyle);
  const wholeBranch = base?.kind !== "head";

  const [choices, setChoices] = useState<ComparisonChoice[]>([]);
  const [choicesError, setChoicesError] = useState<string | null>(null);
  const [historicalDocument, setHistoricalDocument] = useState<{
    path: string;
    view: "diff" | "file";
  } | null>(null);
  const historicalPath = historicalDocument?.path ?? null;

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

  // Match a short ref such as "origin/master" to its full-name choice.
  const selectedKey = (endpoint: ComparisonEndpoint) => {
    const short = endpoint.kind === "ref" ? endpoint.value : null;
    const named =
      short &&
      choices.find(
        ({ endpoint: choice }) =>
          choice.kind === "ref" &&
          [short, `refs/heads/${short}`, `refs/remotes/${short}`].includes(
            choice.value
          )
      );
    return endpointKey(named ? named.endpoint : endpoint);
  };

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
    setTarget((current) =>
      current.kind === "working_tree" ? current : { kind: "working_tree" }
    );
    setPendingSource(sourceJump);
  }, [sourceJump]);
  // Route only on a working-copy result: a ready or failed past-commit load
  // may still be shown while the working copy loads. A failed working-copy
  // load still opens the referenced file.
  const sourceRoute = shownTurn || !pendingSource
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
  }, [sourceRoute, worktreePath]);
  // Publish a routed diff in this render, before switching from an open
  // document can mount the viewport with the previous request.
  const effectiveJumpTarget =
    sourceRoute?.view === "diff" ? sourceRoute.target : jumpTarget;
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
  const showingChanges =
    !shownTurn && (historical ? historicalPath == null : activeDocument == null);
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

    const workingTree = comparisonRequest.target.kind === "working_tree";
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
            setState({
              status: "error",
              message: result.error.message,
              workingTree,
            });
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
          if (current)
            setState({ status: "error", message: String(error), workingTree });
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
      comparison: state.data.comparison,
      files: state.parsed.flatMap((file) => file.reviewFiles),
    });
  }, [state]);

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
      ? comparisonFiles.map(({ path, old_path, patch, marker }) => [path, old_path, patch, marker])
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

  // Viewed marks belong to one comparison; another base or target starts fresh.
  const comparisonKey = JSON.stringify([worktreePath, comparisonRequest]);
  const [viewedState, setViewedState] = useState<{
    key: string;
    paths: ReadonlySet<string>;
  }>({ key: comparisonKey, paths: NO_VIEWED });
  const viewedPaths = useMemo<ReadonlySet<string>>(() => {
    if (viewedState.key !== comparisonKey) return NO_VIEWED;
    const present = [...viewedState.paths].filter((path) => statuses.has(path));
    return present.length === viewedState.paths.size
      ? viewedState.paths
      : new Set(present);
  }, [viewedState, comparisonKey, statuses]);
  const setViewed = useCallback(
    (path: string, viewed: boolean) =>
      setViewedState((current) => {
        const paths = current.key === comparisonKey ? current.paths : NO_VIEWED;
        if (paths.has(path) === viewed)
          return current.key === comparisonKey
            ? current
            : { key: comparisonKey, paths };
        const next = new Set(paths);
        if (viewed) next.add(path);
        else next.delete(path);
        return { key: comparisonKey, paths: next };
      }),
    [comparisonKey]
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
    setJumpTarget({ ...location, path, nonce: --nextLocalJump.current, focusHeader });
  };

  const open = (path: string, view: "file" | "diff") => {
    dismissTurn();
    setReveal(null);
    setActivePath(path);
    if (historical) setHistoricalDocument({ path, view });
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
    requestAnimationFrame(() => sectionRef.current?.focus({ preventScroll: true }));
  };

  const openSelected = (view: "file" | "diff") => {
    if (!selectedFile) return;
    // Opening the document removes the focused diff heading.
    sectionRef.current?.focus({ preventScroll: true });
    open(selectedFile.path, view);
  };

  /** Changes commands and files, in the ⌘K palette's Changes scope. */
  const openChangesPalette = (filesFirst: boolean) => {
    const pick = (button: HTMLButtonElement | null) => () => {
      requestAnimationFrame(() => {
        button?.focus();
        button?.click();
      });
    };
    const fileItems: PaletteItem[] = files.map((file) => ({
      id: `changes-file-${file.path}`,
      scope: "changes",
      label: file.path,
      hint: viewedPaths.has(file.path) ? "Viewed" : undefined,
      detail: STATUS_LETTER[file.status],
      keywords: "file go to jump",
      run: () => jumpToFile(file.path, true),
    }));
    const viewedItems: PaletteItem[] = [...viewedPaths].reverse().map((path, index) => ({
      id: `changes-unview-${path}`,
      scope: "changes",
      label: "Unmark file viewed",
      hint: path,
      // ⇧V unmarks the most recently viewed file, which is listed first.
      detail: index === 0 ? CHANGES_UNVIEW_HINT.keys.join("") : undefined,
      keywords: "unviewed reviewed undo show",
      run: () => {
        setViewed(path, false);
        jumpToFile(path, true);
      },
    }));
    const unviewAll: PaletteItem[] =
      viewedPaths.size > 1
        ? [
            {
              id: "changes-unview-all",
              scope: "changes",
              label: "Unmark all viewed files",
              hint: `${viewedPaths.size} files`,
              keywords: "unviewed reviewed reset clear",
              run: () => {
                for (const path of viewedPaths) setViewed(path, false);
                refocus();
              },
            },
          ]
        : [];
    const viewed = selectedFile && viewedPaths.has(selectedFile.path);
    const commands: PaletteItem[] = [
      { id: "changes-base", scope: "changes", label: CHANGES_COMMANDS.base, keywords: "comparison branch", run: pick(baseButton.current) },
      { id: "changes-target", scope: "changes", label: CHANGES_COMMANDS.target, keywords: "comparison head branch worktree", run: pick(targetButton.current) },
      { id: "changes-files", scope: "changes", label: CHANGES_COMMANDS.files, keywords: "sidebar list explorer open", run: () => void requestAnimationFrame(focusFileList) },
      ...(filesOpen
        ? [
            {
              id: "changes-hide-files",
              scope: "changes",
              label: CHANGES_COMMANDS.hideFiles,
              keywords: "sidebar list explorer collapse close toggle",
              run: () => {
                setFilesOpen(false);
                refocus();
              },
            } satisfies PaletteItem,
          ]
        : []),
      ...(selectedFile
        ? ([
            { id: "changes-diff", scope: "changes", label: CHANGES_COMMANDS.diff, hint: selectedFile.path, run: () => openSelected("diff") },
            { id: "changes-file", scope: "changes", label: CHANGES_COMMANDS.file, hint: selectedFile.path, run: () => openSelected("file") },
            { id: "changes-external", scope: "changes", label: CHANGES_COMMANDS.external, hint: selectedFile.path, run: () => void external.open() },
            // A viewed file's unmark entry is listed with the others below.
            ...(viewed
              ? []
              : [
                  {
                    id: "changes-viewed",
                    scope: "changes",
                    label: "Mark file viewed",
                    hint: selectedFile.path,
                    detail: CHANGES_VIEWED_KEY,
                    keywords: "reviewed done",
                    run: () => {
                      setViewed(selectedFile.path, true);
                      refocus();
                    },
                  } satisfies PaletteItem,
                ]),
          ] satisfies PaletteItem[])
        : []),
      ...viewedItems,
      ...unviewAll,
      {
        id: "changes-layout",
        scope: "changes",
        label: diffStyle === "split" ? CHANGES_COMMANDS.unified : CHANGES_COMMANDS.split,
        keywords: "diff layout view",
        run: () => {
          setDiffStyle(diffStyle === "split" ? "unified" : "split");
          refocus();
        },
      },
      {
        id: "changes-refresh",
        scope: "changes",
        label: CHANGES_COMMANDS.refresh,
        keywords: "reload",
        run: () => {
          refreshAll();
          refocus();
        },
      },
    ];
    const discussionItems = changesDiscussionItems(discussion, refocus);
    openPalette(
      "changes",
      filesFirst
        ? [...fileItems, ...commands, ...discussionItems]
        : [...commands, ...discussionItems, ...fileItems]
    );
  };

  const onKeyDownCapture = (event: KeyboardEvent<HTMLElement>) => {
    if (
      closing == null &&
      (event.metaKey || event.ctrlKey) &&
      !event.altKey &&
      event.key.toLowerCase() === "s"
    ) {
      event.preventDefault();
      if (!shownTurn && !historical && activeDocument) save(activeDocument);
      return;
    }
    const origin = event.nativeEvent.composedPath()[0];
    if (
      closing != null ||
      event.defaultPrevented ||
      event.nativeEvent.isComposing ||
      !(origin instanceof HTMLElement) ||
      !event.currentTarget.contains(origin) ||
      origin.closest('[role="combobox"][aria-expanded="true"]') ||
      document.querySelector('[role="dialog"][aria-modal="true"]')
    )
      return;
    const typing = isEditableShortcutTarget(origin);

    // ⌘K, or / outside text fields: the palette with Changes commands and files.
    const slash =
      event.key === "/" &&
      !typing &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey;
    if (isPaletteShortcut(event) || slash) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) openChangesPalette(slash);
      return;
    }
    if (typing) return;

    const inCursor = !!origin.closest(`[${DIFF_CURSOR_HOST_ATTRIBUTE}]`);
    const vertical = event.key === "ArrowUp" || event.key === "ArrowDown";
    // ⌥⇧↑/↓ outside the diff: previous/next file heading. The diff's own
    // headings and lines move the line cursor instead.
    if (
      vertical &&
      event.altKey &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !inCursor
    ) {
      event.preventDefault();
      event.stopPropagation();
      moveFile(event.key === "ArrowDown" ? 1 : -1);
      return;
    }
    // ⇧V anywhere in Changes, the diff included: unmark the last viewed file.
    if (
      event.key.toLowerCase() === CHANGES_VIEWED_KEY &&
      event.shiftKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey
    ) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) unviewLast();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
      return;

    const list = fileList.current;
    if (list?.contains(origin) && vertical) {
      event.preventDefault();
      event.stopPropagation();
      const rows = Array.from(list.querySelectorAll("button"));
      const index = rows.findIndex((row) => row.contains(origin));
      rows[index + CHANGED_FILE_LIST_KEYS.directions[event.key as "ArrowUp" | "ArrowDown"]]?.focus();
      return;
    }

    // v outside the diff marks the active file; the diff handles its own.
    if (event.key === CHANGES_VIEWED_KEY && !inCursor && selectedFile) {
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat)
        setViewed(selectedFile.path, !viewedPaths.has(selectedFile.path));
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
            onExit={onExit}
            viewedPaths={viewedPaths}
            onViewedChange={setViewed}
            loadSides={loadSides}
            symbolGraphRequest={symbolGraphRequest}
            onRelatedJump={(location) => jumpToFile(location.path, false, location)}
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
      className="changes-keyboard-region flex min-h-0 flex-1 flex-col gap-2 p-3 text-sm"
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
          const cursor = section.querySelector<HTMLElement>(
            `[${DIFF_CURSOR_HOST_ATTRIBUTE}]`
          );
          if (cursor) {
            cursor.focus({ preventScroll: true });
            return;
          }
        }
        if (!(event.target instanceof HTMLElement)) return;
        const path = event.target.closest<HTMLElement>("[data-changes-path]")
          ?.dataset.changesPath;
        if (path) setActivePath(path);
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <div className="changes-comparison-controls">
          <label>
            Base
            <ComparisonSelect
              label="Comparison base"
              buttonRef={baseButton}
              value={base ? selectedKey(base) : "auto"}
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
              buttonRef={targetButton}
              value={selectedKey(target)}
              onChange={(value) => {
                const endpoint = endpointFor(value);

                if (endpoint) {
                  dismissTurn();
                  setTarget(endpoint);
                  setHistoricalDocument(null);
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
              background: true,
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
      {jumpTarget &&
        state.status === "ready" &&
        !files.some((file) => file.path === jumpTarget.path) && (
          <p role="status">
            {jumpTarget.path} has no diff against this baseline. Choose another
            comparison to inspect its changes.
          </p>
        )}
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
            {viewedPaths.size > 0 && (
              <span className="changes-total-viewed">
                {viewedPaths.size}/{files.length} viewed
              </span>
            )}
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
                <nav
                  ref={fileList}
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
                            tabIndex={item.path === selectedFile?.path ? 0 : -1}
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
              aria-current={showingChanges ? "page" : undefined}
              onClick={() => {
                dismissTurn();
                setReveal(null);
                activate(worktreePath, null);
                setHistoricalDocument(null);
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
                    aria-current={
                      !shownTurn && activeDocument === path ? "page" : undefined
                    }
                    title={path}
                    onClick={() => {
                      dismissTurn();
                      setReveal(null);
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
              diffStyle={diffStyle}
              onSave={save}
              onSaved={refreshAll}
            />
          )}
        </div>
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
