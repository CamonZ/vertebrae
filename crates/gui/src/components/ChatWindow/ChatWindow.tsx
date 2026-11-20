import { isEditableShortcutTarget } from "../../utils/keyboard";
import { moveChatArea } from "./chatAreas";
import { FileReferenceNavigationContext } from "../shared/FileReferenceNavigationContext";
import type { FileTarget } from "../shared/FileReferenceNavigationContext";
import {
  EvidenceNavigationContext,
  type SourceLocation,
} from "../shared/EvidenceNavigationContext";
import type { JumpTarget } from "./workspace/AllChangesView";
import {
  SourceEvidence,
  type EvidenceTarget,
} from "./workspace/SourceEvidence";
import { commands } from "../../bindings";
import { ThreadFindContext } from "../thread/find";
import { usePaneFind } from "./usePaneFind";
import { useSidebarResize } from "./workspace/useSidebarResize";
import "./workspaceTabs.css";
import {
  SelectionDiscussionProvider,
  DiscussionSnapshot,
} from "./SelectionDiscussionContext";
import { type CodeSelection } from "./selectionDiscussions";
import { useBackgroundTask } from "../../background/useBackgroundTask";
import type { BackgroundTask } from "../../background/types";
import {
  Profiler,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { useChatSession } from "../../hooks/useChatSession";
import { useChatStore } from "../../stores/chatStore";
import { useChatAssociation } from "../../hooks/useChatAssociation";
import { WorktreeChanges } from "./WorktreeChanges";
import {
  activate,
  discardDraft,
  dirtyPaths,
  saveDocuments,
} from "./workspace/documentStore";
import { UnsavedChangesDialog } from "./workspace/UnsavedChangesDialog";
import { ChatHeader } from "./ChatHeader";
import { ChatMessages } from "./ChatMessages";
import { ChatComposer } from "./ChatComposer";
import { BackgroundActivityPanel } from "./BackgroundActivityPanel";
import {
  activeBackgroundWorkCount,
  backgroundWorkRows,
} from "../../stores/backgroundWork";
import { GateChatStatusBar } from "./GateChatStatusBar";
import { GateDraftProgress } from "./GateDraftProgress";
import { GateSteering } from "./GateSteering";
import { useHumanInputDraft } from "../../hooks/useHumanInputDraft";
import { localChatSessionProjectDisplayName } from "../../utils/localChatSessionGroups";
import {
  usePendingComments,
  usePendingCommentsStore,
} from "../../stores/pendingCommentsStore";
import type {
  PendingComment,
  PendingDiffComment,
  PendingTextComment,
  TextSelectionAnchor,
} from "./assistantTextComments";
import {
  DiffReviewContext,
  type DiffReviewFocus,
  type DiffReviewValue,
  type NewDiffComment,
} from "../thread/toolChange/DiffReviewContext";
import {
  buildToolChain,
  computePlacements,
  createDiffComment,
  reconcileWorktreeComments,
  type WorktreeSnapshot,
} from "../thread/toolChange/diffComments";

let nextPendingCommentId = 0;
let nextFocusNonce = 0;
const prepareToolChain = (
  task: Extract<BackgroundTask, { kind: "tool_chain" }>
) => buildToolChain(task.annotations);

const NO_CHAIN: never[] = [];

interface ChatWindowProps {
  registerChangesToggle?: (toggle: (() => void) | null) => void;
  /** Registers this pane's find opener for ⌘F. */
  registerFind?: (openFind: (() => boolean) | null) => void;
  renderObserver?: (part: "transcript" | "composer") => void;
  sessionId: string;
  /** Closes the whole chat panel (the header's ✕). Provided by the manager. */
  onClosePanel?: () => void;
  /** Starts a fresh local chat for the current project. */
  onStartFresh?: () => void;
  /** Opens/focuses the local chat history drawer. */
  onToggleHistory?: () => void;
  /** Expands/collapses the project chat panel session view. */
  onToggleWide?: () => void;
  isWide?: boolean;
  /** Adds another visible chat pane in the maximized view. */
  onSplitPane?: () => void;
  canSplitPane?: boolean;
  /** Collapses the maximized view back to this pane only. */
  onUnsplitPanes?: () => void;
  /** Closes this pane without closing the underlying chat session. */
  onClosePane?: () => void;
  /** Whether this pane is visible in front (not behind a maximized pane). */
  isForegroundPane?: boolean;
  /** A pending composer focus request this pane should take. */
  composerFocusRevision?: number | null;
  /** Label resolved from this session's captured project association. */
  projectLabel?: string;
  showProjectContext?: boolean;
}

/**
 * ChatWindow renders a single chat session: the header band (title + status),
 * the message thread, and the composer footer with its context-utilization bar.
 */
export function ChatWindow({
  registerChangesToggle,
  registerFind,
  sessionId,
  onClosePanel,
  onStartFresh,
  onToggleHistory,
  onToggleWide,
  isWide = false,
  onSplitPane,
  canSplitPane = true,
  onUnsplitPanes,
  onClosePane,
  isForegroundPane = true,
  composerFocusRevision = null,
  projectLabel,
  showProjectContext = false,
  renderObserver,
}: ChatWindowProps) {
  const panelResize = useSidebarResize({
    initial: 560,
    side: "right",
    label: "Resize Changes panel",
  });
  const [changesSession, setChangesSession] = useState<string | null>(null);
  const [backgroundSession, setBackgroundSession] = useState<string | null>(
    null
  );
  // Dirty documents that block leaving the Changes view until resolved.
  const [leaving, setLeaving] = useState<string[] | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const changesRef = useRef<HTMLElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // The All Changes patch as last loaded, kept after the Changes view closes
  // so its comments can still be placed on the conversation's tool calls.
  const [worktreeState, setWorktreeState] = useState<{
    sessionId: string;
    snapshot: WorktreeSnapshot;
  } | null>(null);
  // The composer chip being hovered or pinned; its target is highlighted.
  const [activeCommentState, setActiveCommentState] = useState<{
    sessionId: string;
    id: string | null;
  } | null>(null);
  const [focusState, setFocusState] = useState<{
    sessionId: string;
    focus: DiffReviewFocus;
  } | null>(null);

  const childControlAvailable = useChatStore((state) => {
    const ownerId = state.sessions[sessionId]?.providerChild?.ownerSessionId;
    const owner = ownerId ? state.sessions[ownerId] : null;
    return (
      !!owner?.backendSessionId &&
      !["closing", "closed", "error"].includes(owner.lifecycle ?? "idle")
    );
  });
  const chat = useChatSession(sessionId);
  const association = useChatAssociation(sessionId);
  const loadOlderReplayMessages = useChatStore(
    (state) => state.loadOlderReplayMessages
  );
  const scopeId = `${sessionId}:${association.record?.worktreePath ?? ""}`;
  // Staged comments outlive this window, so closing the panel keeps them.
  const pendingComments = usePendingComments(scopeId);
  const updateScopedComments = usePendingCommentsStore((state) => state.update);
  const updatePendingComments = useCallback(
    (update: (comments: PendingComment[]) => PendingComment[]) =>
      updateScopedComments(scopeId, update),
    [scopeId, updateScopedComments]
  );
  // After adding or editing a comment the user keeps writing the reply. Wait
  // a frame so the closing editor does not take focus back.
  const focusComposer = useCallback(() => {
    const previousFocus = document.activeElement;
    requestAnimationFrame(() => {
      // A newer selection or focused control takes precedence over this save.
      if (window.getSelection()?.isCollapsed === false) return;
      if (
        document.activeElement !== previousFocus &&
        document.activeElement !== document.body
      )
        return;
      inputRef.current?.focus();
    });
  }, []);
  const handleAddComment = useCallback(
    (anchor: TextSelectionAnchor, body: string) => {
      updatePendingComments((comments) => [
        ...comments,
        {
          ...anchor,
          kind: "text",
          id: `local-comment-${nextPendingCommentId++}`,
          body,
        },
      ]);
      focusComposer();
    },
    [updatePendingComments, focusComposer]
  );
  const handleAddDiffComment = useCallback(
    (input: NewDiffComment) => {
      const comment = createDiffComment({
        ...input,
        id: `local-comment-${nextPendingCommentId++}`,
      });
      if (comment) updatePendingComments((comments) => [...comments, comment]);
      focusComposer();
    },
    [updatePendingComments, focusComposer]
  );
  const handleWorktreeLoaded = useCallback(
    (snapshot: WorktreeSnapshot) => {
      setWorktreeState({ sessionId: scopeId, snapshot });
      // A refresh, baseline change or moved HEAD may have changed the lines
      // All Changes comments were written on.
      updatePendingComments(
        (comments) =>
          reconcileWorktreeComments(comments, snapshot) as PendingComment[]
      );
    },
    [scopeId, updatePendingComments]
  );
  const handleUpdateComment = useCallback(
    (id: string, body: string) => {
      updatePendingComments((comments) =>
        comments.map((comment) =>
          comment.id === id ? { ...comment, body } : comment
        )
      );
      focusComposer();
    },
    [updatePendingComments, focusComposer]
  );
  const handleRemoveComment = useCallback(
    (id: string) => {
      updatePendingComments((comments) =>
        comments.filter((comment) => comment.id !== id)
      );
    },
    [updatePendingComments]
  );
  const handleSend = useCallback(
    (message?: string) => {
      const accepted = chat.handleSend(message);
      if (accepted) updatePendingComments(() => []);
      return accepted;
    },
    [chat.handleSend, updatePendingComments]
  );
  const handleStartSession = useCallback(
    (initialPrompt?: string) => {
      const accepted = chat.handleStartSession(initialPrompt);
      if (accepted) updatePendingComments(() => []);
      return accepted;
    },
    [chat.handleStartSession, updatePendingComments]
  );

  const toolAnnotations = useChatStore(
    (state) => state.sessions[sessionId]?.toolAnnotations
  );
  const hasDiffComments = pendingComments.some(
    (comment) => comment.kind === "diff"
  );
  const toolChainTask = useMemo<Extract<
    BackgroundTask,
    { kind: "tool_chain" }
  > | null>(
    () =>
      hasDiffComments
        ? { kind: "tool_chain", annotations: toolAnnotations }
        : null,
    [hasDiffComments, toolAnnotations]
  );

  const preparedChain = useBackgroundTask(toolChainTask, prepareToolChain);
  const toolChain = preparedChain.value ?? NO_CHAIN;

  const worktreeSnapshot =
    worktreeState?.sessionId === scopeId ? worktreeState.snapshot : null;
  const placements = useMemo(
    () => computePlacements(pendingComments, toolChain, worktreeSnapshot),
    [pendingComments, toolChain, worktreeSnapshot]
  );
  const focus = focusState?.sessionId === sessionId ? focusState.focus : null;
  const activeCommentId =
    activeCommentState?.sessionId === sessionId ? activeCommentState.id : null;
  const handleActiveCommentChange = useCallback(
    (id: string | null) => setActiveCommentState({ sessionId, id }),
    [sessionId]
  );
  const textComments = useMemo(
    () =>
      pendingComments.filter(
        (comment): comment is PendingTextComment => comment.kind === "text"
      ),
    [pendingComments]
  );
  const diffReview = useMemo<DiffReviewValue>(
    () => ({
      comments: pendingComments.filter(
        (comment): comment is PendingDiffComment => comment.kind === "diff"
      ),
      placements,
      chain: toolChain,
      worktree: worktreeSnapshot,
      focus,
      activeCommentId,
      addComment: handleAddDiffComment,
      updateComment: handleUpdateComment,
      removeComment: handleRemoveComment,
    }),
    [
      pendingComments,
      placements,
      toolChain,
      worktreeSnapshot,
      focus,
      activeCommentId,
      handleAddDiffComment,
      handleUpdateComment,
      handleRemoveComment,
    ]
  );
  const [evidenceJump, setEvidenceJump] = useState<{
    sessionId: string;
    worktreePath: string;
    target: JumpTarget;
  } | null>(null);
  const ownWorktreePath = association.record?.worktreePath;
  // Flow evidence reads the conversation's own worktree, else its project.
  const evidenceCheckout =
    ownWorktreePath ?? chat.session?.projectPath ?? undefined;
  const [evidence, setEvidence] = useState<{
    sessionId: string;
    checkout: string;
    target: EvidenceTarget;
    exactPath?: boolean;
  } | null>(null);

  const openFileReference = (target: FileTarget) => {
    setBackgroundSession(null);
    setChangesSession(null);
    setEvidence((previous) => ({
      sessionId,
      checkout: target.root ?? "",
      exactPath: true,
      target: {
        path: target.path,
        history: target.history,
        line: target.line ?? undefined,
        column: target.column ?? undefined,
        nonce: (previous?.target.nonce ?? 0) + 1,
      },
    }));
  };

  const openEvidence = useCallback(
    (location: SourceLocation) => {
      setBackgroundSession(null);
      // Working-copy evidence in the conversation's own worktree opens in
      // Changes, which routes it to the diff or the full file. Open documents
      // keep their drafts in the store.
      if (ownWorktreePath && location.base === undefined) {
        setEvidence(null);
        setChangesSession(sessionId);
        setEvidenceJump((previous) => ({
          sessionId,
          worktreePath: ownWorktreePath,
          target: { ...location, nonce: (previous?.target.nonce ?? 0) + 1 },
        }));
        return;
      }
      // A project checkout or an explicit revision range has no Changes
      // view of its own, so it is shown read-only in place.
      if (!evidenceCheckout) return;
      setEvidence((previous) => ({
        sessionId,
        checkout: evidenceCheckout,
        target: { ...location, nonce: (previous?.target.nonce ?? 0) + 1 },
      }));
      setChangesSession(null);
    },
    [ownWorktreePath, evidenceCheckout, sessionId]
  );
  const attachSelection = (
    anchor: CodeSelection,
    outdated = false,
    body = ""
  ) => {
    const comment = createDiffComment({
      home: anchor.home,
      file: anchor.file,
      span: anchor,
      body,
      id: `local-comment-${nextPendingCommentId++}`,
    });
    if (comment) {
      const attachment = { ...comment, selectionCode: anchor.code, outdated };
      updatePendingComments((comments) => [...comments, attachment]);
    }

    inputRef.current?.focus();
  };
  const handleNavigateComment = useCallback(
    (id: string) => {
      const comment = pendingComments.find((candidate) => candidate.id === id);
      if (comment?.kind !== "diff") return;
      setFocusState({
        sessionId,
        focus: { commentId: id, nonce: nextFocusNonce++ },
      });
      if (comment.home.kind === "worktree") {
        if (!ownWorktreePath) return;
        activate(ownWorktreePath, null);
        setChangesSession(sessionId);
      } else if (changesSession === sessionId && ownWorktreePath) {
        const dirty = dirtyPaths(ownWorktreePath);
        if (dirty.length > 0) setLeaving(dirty);
        else setChangesSession(null);
      }
    },
    [pendingComments, sessionId, ownWorktreePath, changesSession]
  );

  // A draftable gate's draft, read again whenever realtime updates report
  // that it changed; null for every other chat.
  const gate = chat.session?.gate ?? null;
  const gateStatus = chat.session?.gateStatus ?? null;
  const waitingExecutionId =
    gate &&
    (gateStatus?.phase === "drafting" || gateStatus?.phase === "rejected")
      ? gateStatus.waitingExecutionId
      : null;
  const { draft: gateDraft } = useHumanInputDraft(
    waitingExecutionId,
    gateStatus?.draftUpdatedAt
  );

  // A user action that opened or showed this chat asked for its composer.
  // Nothing else moves focus here: store updates and remounts leave it be.
  const markComposerFocusHandled = useChatStore(
    (state) => state.markComposerFocusHandled
  );
  useEffect(() => {
    if (composerFocusRevision === null) return;
    inputRef.current?.focus();
    markComposerFocusHandled(composerFocusRevision);
  }, [composerFocusRevision, markComposerFocusHandled]);

  const worktreePath = association.record?.worktreePath;
  const showChanges = !!worktreePath && changesSession === sessionId;
  const shownEvidence =
    !showChanges &&
    evidence?.sessionId === sessionId &&
    (evidence.exactPath || evidence.checkout === evidenceCheckout)
      ? evidence
      : null;
  const toggleChanges = useCallback(() => {
    if (!worktreePath) return;

    if (!showChanges) {
      setEvidence(null);
      setBackgroundSession(null);
      setChangesSession(sessionId);
    } else {
      const dirty = dirtyPaths(worktreePath);
      if (dirty.length) setLeaving(dirty);
      else setChangesSession(null);
    }
  }, [worktreePath, showChanges, sessionId]);

  const showBackground =
    backgroundSession === sessionId && !showChanges && !shownEvidence;
  const toggleBackground = useCallback(() => {
    if (showBackground) {
      setBackgroundSession(null);
      return;
    }

    // Open documents keep their drafts in the store while hidden.
    setEvidence(null);
    setChangesSession(null);
    setBackgroundSession(sessionId);
  }, [showBackground, sessionId]);

  useEffect(() => {
    if (!registerChangesToggle || !worktreePath || !isForegroundPane) return;

    let current = true;
    let pending = false;

    registerChangesToggle(() => {
      if (pending) return;

      pending = true;

      // Check this conversation's worktree on demand, including committed
      // branch changes against the same default baseline as the Changes view.
      const comparison = {
        base: null,
        target: { kind: "working_tree" as const },
        merge_base: true,
      };

      void commands
        .loadWorktreeChanges(worktreePath, comparison)
        .then((result) => {
          if (current && result.status === "ok" && result.data.files.length > 0)
            toggleChanges();
        })
        .catch(() => {
          // A failed check cannot establish that this worktree has changes.
        })
        .finally(() => {
          pending = false;
        });
    });

    return () => {
      current = false;
      registerChangesToggle(null);
    };
  }, [registerChangesToggle, worktreePath, isForegroundPane, toggleChanges]);

  const conversationRef = useRef<HTMLDivElement>(null);
  const find = usePaneFind(conversationRef);
  useEffect(() => {
    if (!registerFind) return;
    registerFind(find.openFind);
    return () => registerFind(null);
  }, [registerFind, find.openFind]);

  if (!chat.session) return null;

  const isEmpty = chat.session.messages.length === 0;
  const backgroundWork = chat.session.backgroundWork;
  const hasBackgroundWork = backgroundWorkRows(backgroundWork).length > 0;

  const content = (
    <div
      className="chat-association-panel flex h-full min-h-0 flex-col"
      data-testid="local-chat-window"
      data-project-path={chat.session.projectPath ?? ""}
      onKeyDownCapture={(event) => {
        // ⌥←/⌥→ and ⌥= resize the Changes panel while it has focus.
        const changes = changesRef.current;
        const origin = event.nativeEvent.composedPath()[0];
        if (
          !changes ||
          !(origin instanceof HTMLElement) ||
          !changes.contains(origin) ||
          isEditableShortcutTarget(origin) ||
          event.defaultPrevented ||
          event.nativeEvent.isComposing ||
          !event.altKey ||
          event.metaKey ||
          event.ctrlKey ||
          event.shiftKey ||
          origin.closest('[role="combobox"][aria-expanded="true"]') ||
          document.querySelector('[role="dialog"][aria-modal="true"]')
        )
          return;
        const resize =
          event.key === "ArrowLeft"
            ? () => panelResize.resizeBy(1)
            : event.key === "ArrowRight"
              ? () => panelResize.resizeBy(-1)
              : event.code === "Equal"
                ? panelResize.cycleWidth
                : null;
        if (!resize) return;
        event.preventDefault();
        event.stopPropagation();
        resize();
      }}
    >
      <ChatHeader
        showProjectContext={showProjectContext}
        label={chat.session.title?.trim() || chat.session.label}
        lifecycle={chat.lifecycle}
        isActive={chat.isActive}
        isClosing={chat.lifecycle === "closing"}
        canStopGeneration={chat.canStopGeneration}
        onClosePanel={onClosePanel}
        onStartFresh={onStartFresh}
        onToggleHistory={onToggleHistory}
        changesOpen={showChanges}
        onToggleChanges={worktreePath ? toggleChanges : undefined}
        backgroundOpen={showBackground}
        backgroundRunning={activeBackgroundWorkCount(backgroundWork)}
        onToggleBackground={
          hasBackgroundWork || showBackground ? toggleBackground : undefined
        }
        onToggleWide={onToggleWide}
        isWide={isWide}
        onSplitPane={onSplitPane}
        canSplitPane={canSplitPane}
        onUnsplitPanes={onUnsplitPanes}
        onClosePane={onClosePane}
        onClearMessages={() => void chat.handleClearMessages()}
        onStopGeneration={() => void chat.handleStopGeneration()}
        onTitleSave={chat.handleTitleSave}
        onTitleRegenerate={() => void chat.handleRegenerateTitle()}
        isTitleRegenerating={chat.isTitleRegenerating}
        titleError={chat.titleError}
        projectLabel={
          projectLabel ??
          localChatSessionProjectDisplayName(chat.session.projectPath)
        }
      />
      <div
        ref={panelResize.containerRef}
        className="chat-with-changes min-h-0 flex-1"
        data-changes-open={
          showChanges || shownEvidence != null || showBackground
        }
      >
        {showChanges && (
          <aside
            aria-label="Changes panel"
            className="changes-side-panel"
            style={{ flexBasis: panelResize.width }}
          >
            <WorktreeChanges
              key={`${sessionId}:${worktreePath}`}
              ref={changesRef}
              worktreePath={worktreePath}
              onChangesLoaded={handleWorktreeLoaded}
              onExit={() => inputRef.current?.focus()}
              onEdge={(direction) =>
                void moveChatArea(document.activeElement, direction)
              }
              sourceJump={
                evidenceJump?.sessionId === sessionId &&
                evidenceJump.worktreePath === worktreePath
                  ? evidenceJump.target
                  : null
              }
            />
          </aside>
        )}
        {shownEvidence && (
          <aside
            aria-label={
              shownEvidence.exactPath
                ? "File reference panel"
                : "Evidence panel"
            }
            className="changes-side-panel"
            style={{ flexBasis: panelResize.width }}
          >
            <SourceEvidence
              exactPath={shownEvidence.exactPath}
              checkout={shownEvidence.checkout}
              target={shownEvidence.target}
              onClose={() => setEvidence(null)}
            />
          </aside>
        )}
        {showBackground && (
          <aside
            aria-label="Background tasks panel"
            className="changes-side-panel"
            style={{ flexBasis: panelResize.width }}
          >
            <BackgroundActivityPanel
              work={backgroundWork}
              onClose={() => setBackgroundSession(null)}
            />
          </aside>
        )}
        {(showChanges || shownEvidence || showBackground) && (
          <div {...panelResize.handleProps} className="changes-resize-handle" />
        )}
        {worktreePath && (
          <UnsavedChangesDialog
            paths={leaving}
            busy={leaveBusy}
            onCancel={() => setLeaving(null)}
            onDiscard={() => {
              for (const path of leaving ?? []) {
                discardDraft(worktreePath, path);
              }
              setLeaving(null);
              setChangesSession(null);
            }}
            onSave={() => {
              setLeaveBusy(true);
              void saveDocuments(worktreePath, leaving ?? [])
                .then((failed) => {
                  // Stay in Changes on the first document that was not saved
                  // so its error or conflict is visible.
                  if (failed.length > 0) activate(worktreePath, failed[0]);
                  else setChangesSession(null);
                })
                .finally(() => {
                  setLeaveBusy(false);
                  setLeaving(null);
                });
            }}
          />
        )}
        <div
          ref={conversationRef}
          className="main-conversation flex min-h-0 min-w-0 flex-col"
          data-testid="main-conversation"
        >
          {find.bar}
          {gate && gateStatus && (
            <GateChatStatusBar stepName={gate.step_name} status={gateStatus} />
          )}
          {gate &&
            gateStatus &&
            gateDraft &&
            (gate.fields?.length ?? 0) > 0 && (
              <GateDraftProgress
                fields={gate.fields ?? []}
                draft={gateDraft}
                attempt={gateStatus.attempt}
              />
            )}
          {preparedChain.error && (
            <div role="alert">
              Diff comments could not be prepared: {preparedChain.error}{" "}
              <button type="button" onClick={preparedChain.retry}>
                Retry
              </button>
            </div>
          )}
          <ThreadFindContext.Provider value={find.findQuery}>
            <Profiler
              id={`${sessionId}-transcript`}
              onRender={() => renderObserver?.("transcript")}
            >
              <ChatMessages
                sessionId={sessionId}
                isVisible={true}
                projectPath={chat.session.projectPath}
                messages={chat.messages}
                assistantLabel={chat.assistantLabel}
                gate={chat.session.gate}
                isEmpty={isEmpty}
                isActive={chat.isActive || childControlAvailable}
                isWaiting={chat.isWaiting}
                activityLabel={chat.activityLabel}
                compactionSummary={chat.compactionSummary}
                streamingAssistant={chat.streamingAssistant}
                isLoadingInitialHistory={
                  chat.session.providerReplay?.loading === "initial"
                }
                hasOlderMessages={chat.session.providerReplay?.hasMore === true}
                isLoadingOlderMessages={
                  chat.session.providerReplay?.loading === "older"
                }
                replayError={chat.session.providerReplay?.error ?? null}
                onLoadOlderMessages={() => loadOlderReplayMessages(sessionId)}
                onAddComment={handleAddComment}
                textComments={textComments}
                activeCommentId={activeCommentId}
                footer={
                  <>
                    <DiscussionSnapshot snapshot={worktreeSnapshot} />
                    {gate && gateStatus && gateDraft && (
                      <GateSteering
                        sessionId={sessionId}
                        gate={gate}
                        status={gateStatus}
                        draft={gateDraft}
                      />
                    )}
                  </>
                }
              />
            </Profiler>
          </ThreadFindContext.Provider>
          <Profiler
            id={`${sessionId}-composer`}
            onRender={() => renderObserver?.("composer")}
          >
            <ChatComposer
              session={chat.session}
              inputValue={chat.inputValue}
              setInputValue={chat.setInputValue}
              inputRef={inputRef}
              harnessCatalog={chat.harnessCatalog}
              visibleHarness={chat.visibleHarness}
              providerOptions={chat.providerOptions}
              selectedProviderId={chat.selectedProviderId}
              supportedModelIds={chat.supportedModelIds}
              reasoningEfforts={chat.reasoningEfforts}
              supportedReasoningEffortIds={chat.supportedReasoningEffortIds}
              speedTiers={chat.speedTiers}
              supportedSpeedTierIds={chat.supportedSpeedTierIds}
              isBusy={chat.isBusy}
              isActive={chat.isActive}
              lockedHarness={chat.lockedHarness}
              hasResume={chat.hasResume}
              hasAvailableHarness={chat.hasAvailableHarness}
              canUseComposer={chat.canUseComposer}
              canSendMessage={chat.canSendMessage}
              shouldStartOrResume={chat.shouldStartOrResume}
              submitLabel={chat.submitLabel}
              composerPlaceholder={chat.composerPlaceholder}
              ctxPct={chat.ctxPct}
              ctxColor={chat.ctxColor}
              usage={chat.usage}
              threadTotalTokens={chat.threadTotalTokens}
              pendingComments={pendingComments}
              onUpdateComment={handleUpdateComment}
              onRemoveComment={handleRemoveComment}
              onNavigateComment={handleNavigateComment}
              onActiveCommentChange={handleActiveCommentChange}
              onSend={handleSend}
              onStartSession={handleStartSession}
              onHarnessChange={chat.handleHarnessChange}
              onModelChange={chat.handleModelChange}
              onReasoningEffortChange={chat.handleReasoningEffortChange}
              onSpeedTierChange={chat.handleSpeedTierChange}
              onPermissionModeChange={chat.handlePermissionModeChange}
            />
          </Profiler>
        </div>
      </div>
    </div>
  );
  return (
    <EvidenceNavigationContext.Provider
      value={evidenceCheckout ? openEvidence : undefined}
    >
      <DiffReviewContext.Provider value={diffReview}>
        <SelectionDiscussionProvider
          key={JSON.stringify([chat.session.projectPath, sessionId, worktreePath])}
          worktreePath={worktreePath ?? ""}
          parentChatId={sessionId}
          projectPath={chat.session.projectPath}
          harness={chat.session.harness}
          providerId={chat.session.providerId ?? undefined}
          modelId={chat.session.selectedModelId}
          reasoningEffort={chat.session.selectedReasoningEffort}
          speedTier={chat.session.selectedSpeedTier}
          personality={chat.session.selectedPersonality}
          onOpen={() => setChangesSession(sessionId)}
          onAttach={attachSelection}
        >
          <FileReferenceNavigationContext.Provider value={openFileReference}>
            {content}
          </FileReferenceNavigationContext.Provider>
        </SelectionDiscussionProvider>
      </DiffReviewContext.Provider>
    </EvidenceNavigationContext.Provider>
  );
}
