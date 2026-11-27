import {
  useChatAttention,
  useMarkChatTurnViewed,
} from "../../hooks/useChatAttention";
import { annotationWorktree } from "../../stores/toolAnnotations";
import { useToolAnnotation } from "../../hooks/useToolAnnotation";
import type {
  TurnDocumentTarget,
  TurnDocumentVersion,
} from "./workspace/TurnDocument";
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
import { ThreadFindContext } from "../thread/find";
import { usePaneFind } from "./usePaneFind";
import {
  resizeFromRegionKey,
  useSidebarResize,
} from "./workspace/useSidebarResize";
import "./workspaceTabs.css";
import { SelectionDiscussionProvider } from "./SelectionDiscussionContext";
import { useChatDiscussions } from "./selectionDiscussionState";
import { ChatSideColumn, SIDE_COLUMN_BESIDE_MIN_WIDTH } from "./ChatSideColumn";
import { SideDiscussions } from "./SideDiscussions";
import { useChatSideColumn } from "./useChatSideColumn";
import {
  useChatSideColumnStore,
  useSideColumnView,
} from "../../stores/chatSideColumnStore";
import type { SideColumnControls } from "./ChatPaneList";
import {
  selectionAttachment,
  type CodeSelection,
} from "./selectionDiscussions";
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
import { useWorktreePr } from "../../hooks/useWorktreePr";
import { savedPrOf } from "../../stores/prLinks";
import { linkedPullRequest } from "../../stores/worktreePrStore";
import {
  activate,
  discardDraft,
  dirtyPaths,
  saveDocuments,
} from "./workspace/documentStore";
import { UnsavedChangesDialog } from "./workspace/UnsavedChangesDialog";
import { chatFocusArea } from "../../stores/chatViewMemory";
import { focusPaneTranscript } from "./chatAreas";
import { ChatHeader } from "./ChatHeader";
import { ChatMessages } from "./ChatMessages";
import { ChatComposer } from "./ChatComposer";
import { useChatWindowPalette } from "./chatPaletteCommands";
import { ChatQueue } from "./ChatQueue";
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
  /** Registers this chat's side column for ⌘⇧B and ⌘⇧[ ]. */
  registerSideColumn?: (controls: SideColumnControls | null) => void;
  /** Registers this pane's find opener for ⌘F. */
  registerFind?: (openFind: (() => boolean) | null) => void;
  renderObserver?: (part: "transcript" | "composer") => void;
  sessionId: string;
  /** Closes the whole chat panel (the header's ✕). Provided by the manager. */
  onClosePanel?: () => void;
  /** Starts a fresh local chat for the current project. */
  onStartFresh?: () => void;
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
  registerSideColumn,
  registerFind,
  sessionId,
  onClosePanel,
  onStartFresh,
  isForegroundPane = true,
  composerFocusRevision = null,
  projectLabel,
  showProjectContext = false,
  renderObserver,
}: ChatWindowProps) {
  const panelResize = useSidebarResize({
    // Wide windows give the side column ~45% so a diff is not clipped.
    initial: Math.max(560, Math.round(window.innerWidth * 0.45)),
    side: "right",
    label: "Resize side column",
  });
  // The side column outlives this window: hidden tabs unmount.
  const sideColumn = useSideColumnView(sessionId);
  const showSection = useChatSideColumnStore((state) => state.show);
  const closeSideColumn = useChatSideColumnStore((state) => state.close);
  const changesOpen = sideColumn.open && sideColumn.section === "changes";
  // Dirty documents that block leaving the Changes view until resolved.
  const [leaving, setLeaving] = useState<string[] | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const sideRef = useRef<HTMLElement>(null);
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
  const attention = useChatAttention(sessionId);
  useMarkChatTurnViewed(sessionId, isForegroundPane);
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
  const commentNumbers = useMemo(
    () =>
      new Map(pendingComments.map((comment, index) => [comment.id, index + 1])),
    [pendingComments]
  );
  const [openCommentRequest, setOpenCommentRequest] = useState<{
    sessionId: string;
    id: string;
    nonce: number;
  } | null>(null);
  const handleOpenComment = useCallback(
    (id: string) =>
      setOpenCommentRequest({ sessionId, id, nonce: nextFocusNonce++ }),
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
  const [sourceRequest, setSourceRequest] = useState<
    | ((
        | {
            kind: "turn";
            target: TurnDocumentTarget;
            nonce: number;
            version: TurnDocumentVersion;
          }
        | { kind: "working"; worktreePath: string; target: JumpTarget }
        | { kind: "checkout"; worktreePath: string }
      ) & { sessionId: string })
    | null
  >(null);
  const nextSourceNonce = useRef(0);
  const leaveChanges = useCallback(() => {
    setSourceRequest(null);
    closeSideColumn(sessionId);
  }, [closeSideColumn, sessionId]);
  const ownWorktreePath = association.record?.worktreePath;
  const evidenceCheckout =
    ownWorktreePath ?? chat.session?.projectPath ?? undefined;
  const [evidence, setEvidence] = useState<{
    sessionId: string;
    checkout: string;
    target: EvidenceTarget;
    fileReference: boolean;
  } | null>(null);

  const openSource = useCallback(
    (
      location: SourceLocation,
      reference?: Pick<FileTarget, "root" | "history">,
      fileReference = false
    ) => {
      const nonce = ++nextSourceNonce.current;
      const { path, line, endLine, column } = location;
      const revision =
        location.commit !== undefined
          ? { kind: "commit" as const, commit: location.commit }
          : location.base !== undefined
            ? {
                kind: "range" as const,
                base: location.base,
                head: location.head,
              }
            : null;
      if (revision) {
        const checkout = fileReference
          ? (reference?.root ?? evidenceCheckout)
          : evidenceCheckout;
        if (!checkout) return;
        setSourceRequest(null);
        closeSideColumn(sessionId);
        setEvidence({
          sessionId,
          checkout,
          target: { ...location, nonce, revision },
          fileReference,
        });
        return;
      }

      if (reference?.history || fileReference) {
        setSourceRequest({
          sessionId,
          kind: "turn",
          version: "turn",
          nonce,
          target: {
            path,
            root: reference?.root ?? null,
            history: reference?.history ?? { sessionId, turnId: null },
            column,
            reveal:
              line === undefined
                ? null
                : {
                    path,
                    line,
                    endLine: Math.max(endLine ?? line, line),
                    nonce,
                  },
          },
        });
      } else if (evidenceCheckout) {
        setSourceRequest({
          sessionId,
          kind: "working",
          worktreePath: evidenceCheckout,
          target: { ...location, nonce },
        });
      } else {
        return;
      }

      setEvidence(null);
      showSection(sessionId, "changes");
    },
    [evidenceCheckout, sessionId, closeSideColumn, showSection]
  );

  const openFileReference = (target: FileTarget) =>
    openSource(
      {
        path: target.path,
        commit: target.commit,
        line: target.line ?? undefined,
        column: target.column ?? undefined,
      },
      target,
      true
    );

  const source = sourceRequest?.sessionId === sessionId ? sourceRequest : null;
  const turn = source?.kind === "turn" ? source.target : null;
  const annotationKey = turn?.history.turnId
    ? JSON.stringify(["turn", turn.history.turnId])
    : null;
  const origin = useToolAnnotation(
    turn?.history.sessionId,
    annotationKey,
    "worktree_origin"
  );
  const capture = useToolAnnotation(
    turn?.history.sessionId,
    annotationKey,
    "worktree_history"
  );
  const turnRoot =
    annotationWorktree(origin) ??
    annotationWorktree(capture) ??
    turn?.root ??
    null;
  const worktreePath = changesOpen
    ? source?.kind === "checkout"
      ? source.worktreePath
      : (turnRoot ?? evidenceCheckout)
    : ownWorktreePath;

  const attachSelection = (
    anchor: CodeSelection,
    outdated = false,
    body = ""
  ) => {
    const attachment = selectionAttachment(
      anchor,
      `local-comment-${nextPendingCommentId++}`,
      body,
      outdated
    );
    if (attachment)
      updatePendingComments((comments) => [...comments, attachment]);

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
        setSourceRequest(null);
        activate(ownWorktreePath, null);
        showSection(sessionId, "changes");
      } else if (changesOpen && worktreePath) {
        const dirty = dirtyPaths(worktreePath);
        if (dirty.length > 0) setLeaving(dirty);
        else leaveChanges();
      }
    },
    [
      pendingComments,
      sessionId,
      ownWorktreePath,
      changesOpen,
      worktreePath,
      showSection,
      leaveChanges,
    ]
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
    // Returning to a chat puts the keyboard back in the area it left.
    const area = chatFocusArea(sessionId);
    const composer = inputRef.current;
    const pane = composer?.closest("[data-pane-id]");
    const side =
      area === "side"
        ? pane?.querySelector<HTMLElement>("[data-chat-area]")
        : null;
    if (side) side.focus({ preventScroll: true });
    else if (
      composer &&
      !(area === "transcript" && focusPaneTranscript(composer))
    ) {
      composer.focus();
      // Script focus puts the caret at the start; continue the draft.
      const end = composer.value.length;
      composer.setSelectionRange(end, end);
    }
    markComposerFocusHandled(composerFocusRevision);
  }, [composerFocusRevision, markComposerFocusHandled, sessionId]);

  const showChanges = !!worktreePath && changesOpen;
  // The chat's GitHub PR follows the worktree and branch pinned on its
  // association record, never the checkout's HEAD. The creation default (not
  // yet associated) and an association without a branch have no PR target.
  const prWorktree = association.record.defaultWorktree
    ? null
    : association.record.worktreePath;
  const prBranch = prWorktree ? association.record.branch : null;
  const worktreePr = useWorktreePr(prWorktree, prBranch);
  // A chat synced from another machine has no worktree here: its saved PR
  // is shown as is, never read.
  const linkedPr =
    prWorktree && prBranch
      ? linkedPullRequest(worktreePr.association)
      : chat.session
        ? savedPrOf(chat.session)
        : null;
  const linkedPrChecks =
    linkedPr && worktreePr.entry.snapshot ? worktreePr.counts : null;
  const shownEvidence =
    !showChanges &&
    evidence?.sessionId === sessionId &&
    (evidence.fileReference || evidence.checkout === evidenceCheckout)
      ? evidence
      : null;
  const discussionKey = JSON.stringify([
    chat.session?.projectPath,
    sessionId,
    ownWorktreePath,
  ]);
  const discussions = useChatDiscussions(discussionKey);
  const backgroundWork = chat.session?.backgroundWork;
  const backgroundRunning = activeBackgroundWorkCount(backgroundWork);
  const changedFiles = worktreeSnapshot
    ? new Set(
        worktreeSnapshot.files.map((file) => file.newPath ?? file.oldPath)
      ).size
    : null;
  const sectionCounts = useMemo(
    () => ({
      changes: changedFiles ?? 0,
      discussions: discussions.count,
      background: backgroundRunning,
    }),
    [changedFiles, discussions.count, backgroundRunning]
  );
  const side = useChatSideColumn({
    sessionId,
    view: sideColumn,
    counts: sectionCounts,
    register: registerSideColumn,
    panel: sideRef,
    worktreePath,
    isMainCheckout:
      !!worktreePath && worktreePath === chat.session?.projectPath,
    active: isForegroundPane,
    evidenceShown: !!shownEvidence,
    onDirty: setLeaving,
    // A working-tree reference stays for the next time Changes opens.
    onClose: () =>
      setSourceRequest((current) =>
        current?.kind === "working" ? current : null
      ),
    onSelect: (section) => {
      setEvidence(null);
      if (section !== "changes") setSourceRequest(null);
    },
  });
  const shownSection = side.shownSection;

  const conversationRef = useRef<HTMLDivElement>(null);
  const find = usePaneFind(conversationRef);
  const rootRef = useRef<HTMLDivElement>(null);
  const modelSettingsHandle = useRef<(() => void) | null>(null);
  useChatWindowPalette(rootRef, chat, association.record, modelSettingsHandle);
  useEffect(() => {
    if (!registerFind) return;
    registerFind(find.openFind);
    return () => registerFind(null);
  }, [registerFind, find.openFind]);

  if (!chat.session) return null;

  const isEmpty = chat.session.messages.length === 0;
  const hasBackgroundWork = backgroundWorkRows(backgroundWork).length > 0;
  // The side column always sits beside the transcript (shown, it expands the
  // chat). Narrow, source evidence replaces the transcript as the chat's view.
  const sidePlacement =
    shownSection || panelResize.available >= SIDE_COLUMN_BESIDE_MIN_WIDTH
      ? "beside"
      : "view";
  const panelProps = {
    className: `changes-side-panel${panelResize.easing ? " is-easing" : ""}`,
    style:
      sidePlacement === "beside" ? { flexBasis: panelResize.width } : undefined,
  };

  const content = (
    <div
      ref={rootRef}
      className="chat-association-panel flex h-full min-h-0 flex-col"
      data-testid="local-chat-window"
      data-project-path={chat.session.projectPath ?? ""}
      // ⌥←/⌥→ and ⌥= resize the side column while it has focus.
      onKeyDownCapture={(event) =>
        resizeFromRegionKey(event, sideRef.current, panelResize)
      }
    >
      <ChatHeader
        showProjectContext={showProjectContext}
        label={chat.session.title?.trim() || chat.session.label}
        attention={attention}
        isClosing={chat.lifecycle === "closing"}
        canStopGeneration={chat.canStopGeneration}
        isGenerating={chat.isGenerating}
        onClosePanel={onClosePanel}
        onStartFresh={onStartFresh}
        sideSection={shownSection}
        onToggleSection={side.toggle}
        changesAvailable={!!worktreePath}
        backgroundAvailable={hasBackgroundWork}
        backgroundRunning={backgroundRunning}
        onClearMessages={() => void chat.handleClearMessages()}
        onStopGeneration={() => void chat.handleStopGeneration()}
        onTitleSave={chat.handleTitleSave}
        onTitleRegenerate={
          chat.canRegenerateTitle
            ? () => void chat.handleRegenerateTitle()
            : undefined
        }
        isTitleRegenerating={chat.isTitleRegenerating}
        titleError={chat.titleError}
        projectLabel={
          projectLabel ??
          localChatSessionProjectDisplayName(chat.session.projectPath)
        }
        entity={
          association.record.ticketId
            ? {
                id: association.record.ticketId,
                level: association.record.entityLevel ?? "ticket",
              }
            : null
        }
        linkedPr={linkedPr}
        linkedPrChecks={linkedPrChecks}
        onOpenPrInChanges={
          worktreePath
            ? () => {
                if (shownSection !== "changes") side.select("changes");
              }
            : undefined
        }
      />
      <div
        ref={panelResize.containerRef}
        className="chat-with-changes min-h-0 flex-1"
        data-changes-open={shownSection !== null || shownEvidence != null}
        data-side-placement={sidePlacement}
      >
        {shownSection && (
          <aside ref={sideRef} aria-label="Side column" {...panelProps}>
            <ChatSideColumn
              section={shownSection}
              counts={{
                changes: changedFiles,
                background: backgroundRunning,
              }}
              available={side.available}
              onSection={side.select}
            >
              {shownSection === "changes" && worktreePath ? (
                <WorktreeChanges
                  key={`${sessionId}:${worktreePath}`}
                  worktreePath={worktreePath}
                  prBranch={worktreePath === prWorktree ? prBranch : null}
                  sessionId={sessionId}
                  onChangesLoaded={
                    worktreePath === evidenceCheckout
                      ? handleWorktreeLoaded
                      : undefined
                  }
                  onExit={() => inputRef.current?.focus()}
                  sourceJump={
                    source?.kind === "working" &&
                    source.worktreePath === worktreePath
                      ? source.target
                      : null
                  }
                  turnDocument={
                    source?.kind === "turn"
                      ? {
                          ...source,
                          target: { ...source.target, root: turnRoot },
                        }
                      : null
                  }
                  onTurnDismiss={(nonce) => {
                    // Keep browsing the same checkout after leaving the reference.
                    setSourceRequest((current) =>
                      current?.kind === "turn" && current.nonce === nonce
                        ? { kind: "checkout", sessionId, worktreePath }
                        : current
                    );
                  }}
                  onTurnVersionChange={(nonce, version) => {
                    setSourceRequest((current) =>
                      current?.kind === "turn" && current.nonce === nonce
                        ? { ...current, version }
                        : current
                    );
                  }}
                />
              ) : shownSection === "discussions" ? (
                <SideDiscussions />
              ) : (
                <BackgroundActivityPanel work={backgroundWork} />
              )}
            </ChatSideColumn>
          </aside>
        )}
        {shownEvidence && (
          <aside
            aria-label={
              shownEvidence.fileReference
                ? "File reference panel"
                : "Evidence panel"
            }
            ref={sideRef}
            {...panelProps}
          >
            <SourceEvidence
              checkout={shownEvidence.checkout}
              target={shownEvidence.target}
              onClose={() => setEvidence(null)}
            />
          </aside>
        )}
        {(shownSection || shownEvidence) && sidePlacement === "beside" && (
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
              leaveChanges();
            }}
            onSave={() => {
              setLeaveBusy(true);
              void saveDocuments(worktreePath, leaving ?? [])
                .then((failed) => {
                  // Stay in Changes on the first document that was not saved
                  // so its error or conflict is visible.
                  if (failed.length > 0) activate(worktreePath, failed[0]);
                  else leaveChanges();
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
                commentNumbers={commentNumbers}
                onOpenComment={handleOpenComment}
                footer={
                  gate &&
                  gateStatus &&
                  gateDraft && (
                    <GateSteering
                      sessionId={sessionId}
                      gate={gate}
                      status={gateStatus}
                      draft={gateDraft}
                    />
                  )
                }
              />
            </Profiler>
          </ThreadFindContext.Provider>
          <Profiler
            id={`${sessionId}-composer`}
            onRender={() => renderObserver?.("composer")}
          >
            <ChatQueue session={chat.session} busy={chat.isBusy} />
            <ChatComposer
              session={chat.session}
              inputValue={chat.inputValue}
              setInputValue={chat.setInputValue}
              inputRef={inputRef}
              modelSettingsHandle={modelSettingsHandle}
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
              openCommentRequest={
                openCommentRequest?.sessionId === sessionId
                  ? openCommentRequest
                  : null
              }
              onSend={handleSend}
              onSteer={chat.canSteer ? chat.handleSteer : undefined}
              isSteering={chat.isSteering}
              steeringStatus={chat.steeringStatus}
              steeringPhase={chat.steeringPhase}
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
      value={evidenceCheckout ? openSource : undefined}
    >
      <DiffReviewContext.Provider value={diffReview}>
        <SelectionDiscussionProvider
          key={discussionKey}
          controller={discussions.controller}
          worktreePath={ownWorktreePath ?? worktreePath ?? ""}
          parentChatId={sessionId}
          projectPath={chat.session.projectPath}
          harness={chat.session.harness}
          providerId={chat.session.providerId ?? undefined}
          modelId={chat.session.selectedModelId}
          reasoningEffort={chat.session.selectedReasoningEffort}
          speedTier={chat.session.selectedSpeedTier}
          personality={chat.session.selectedPersonality}
          snapshot={worktreeSnapshot}
          onOpen={() => side.select("changes")}
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
