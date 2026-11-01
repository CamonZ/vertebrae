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
import { GateChatStatusBar } from "./GateChatStatusBar";
import { GateDraftProgress } from "./GateDraftProgress";
import { GateSteering } from "./GateSteering";
import { useHumanInputDraft } from "../../hooks/useHumanInputDraft";
import { localChatSessionProjectDisplayName } from "../../utils/localChatSessionGroups";
import type {
  PendingComment,
  PendingDiffComment,
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
const NO_CHAIN: never[] = [];
const NO_COMMENTS: PendingComment[] = [];

interface ChatWindowProps {
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
  /** Whether this pane should receive composer autofocus. */
  autoFocusComposer?: boolean;
  /** Label resolved from this session's captured project association. */
  projectLabel?: string;
  showProjectContext?: boolean;
}

/**
 * ChatWindow renders a single chat session: the header band (title + status),
 * the message thread, and the composer footer with its context-utilization bar.
 */
export function ChatWindow({
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
  autoFocusComposer = true,
  projectLabel,
  showProjectContext = false,
  renderObserver,
}: ChatWindowProps) {
  const [changesSession, setChangesSession] = useState<string | null>(null);
  // Dirty documents that block leaving the Changes view until resolved.
  const [leaving, setLeaving] = useState<string[] | null>(null);
  const [leaveBusy, setLeaveBusy] = useState(false);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [pendingCommentState, setPendingCommentState] = useState<{
    sessionId: string;
    comments: PendingComment[];
  }>(() => ({ sessionId, comments: [] }));
  // The All Changes patch as last loaded, kept after the Changes view closes
  // so its comments can still be placed on the conversation's tool calls.
  const [worktreeState, setWorktreeState] = useState<{
    sessionId: string;
    snapshot: WorktreeSnapshot;
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
  const pendingComments =
    pendingCommentState.sessionId === sessionId
      ? pendingCommentState.comments
      : NO_COMMENTS;
  const updatePendingComments = useCallback(
    (update: (comments: PendingComment[]) => PendingComment[]) => {
      setPendingCommentState((current) => ({
        sessionId,
        comments: update(
          current.sessionId === sessionId ? current.comments : []
        ),
      }));
    },
    [sessionId]
  );
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
    },
    [updatePendingComments]
  );
  const handleAddDiffComment = useCallback(
    (input: NewDiffComment) => {
      const comment = createDiffComment({
        ...input,
        id: `local-comment-${nextPendingCommentId++}`,
      });
      if (comment) updatePendingComments((comments) => [...comments, comment]);
    },
    [updatePendingComments]
  );
  const handleWorktreeLoaded = useCallback(
    (snapshot: WorktreeSnapshot) => {
      setWorktreeState({ sessionId, snapshot });
      // A refresh, baseline change or moved HEAD may have changed the lines
      // All Changes comments were written on.
      updatePendingComments(
        (comments) =>
          reconcileWorktreeComments(comments, snapshot) as PendingComment[]
      );
    },
    [sessionId, updatePendingComments]
  );
  const handleUpdateComment = useCallback(
    (id: string, body: string) => {
      updatePendingComments((comments) =>
        comments.map((comment) =>
          comment.id === id ? { ...comment, body } : comment
        )
      );
    },
    [updatePendingComments]
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
  const toolChain = useMemo(
    () => (hasDiffComments ? buildToolChain(toolAnnotations) : NO_CHAIN),
    [hasDiffComments, toolAnnotations]
  );
  const worktreeSnapshot =
    worktreeState?.sessionId === sessionId ? worktreeState.snapshot : null;
  const placements = useMemo(
    () => computePlacements(pendingComments, toolChain, worktreeSnapshot),
    [pendingComments, toolChain, worktreeSnapshot]
  );
  const focus = focusState?.sessionId === sessionId ? focusState.focus : null;
  const diffReview = useMemo<DiffReviewValue>(
    () => ({
      comments: pendingComments.filter(
        (comment): comment is PendingDiffComment => comment.kind === "diff"
      ),
      placements,
      chain: toolChain,
      worktree: worktreeSnapshot,
      focus,
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
      handleAddDiffComment,
      handleUpdateComment,
      handleRemoveComment,
    ]
  );
  const ownWorktreePath = association.record?.worktreePath;
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

  // Focus the composer when this chat window is the foreground pane.
  useEffect(() => {
    if (!autoFocusComposer) return;
    inputRef.current?.focus();
  }, [autoFocusComposer]);

  if (!chat.session) return null;

  const worktreePath = association.record?.worktreePath;
  const showChanges = !!worktreePath && changesSession === sessionId;
  const isEmpty = chat.session.messages.length === 0;

  const content = (
    <div
      className="chat-association-panel flex h-full min-h-0 flex-col"
      data-testid="local-chat-window"
      data-project-path={chat.session.projectPath ?? ""}
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
      {worktreePath && (
        <div
          role="group"
          aria-label="Chat view"
          className="flex gap-3 border-b border-white/10 px-3 py-2 text-sm"
        >
          <button
            type="button"
            data-testid="local-chat-view-conversation"
            aria-pressed={!showChanges}
            onClick={() => {
              const dirty = showChanges ? dirtyPaths(worktreePath) : [];
              if (dirty.length > 0) setLeaving(dirty);
              else setChangesSession(null);
            }}
          >
            Conversation
          </button>
          <button
            type="button"
            data-testid="local-chat-view-changes"
            aria-pressed={showChanges}
            onClick={() => setChangesSession(sessionId)}
          >
            Changes
          </button>
        </div>
      )}
      <div className="grid min-h-0 flex-1 grid-cols-1 grid-rows-1">
        {showChanges && (
          <div className="flex min-h-0 flex-col" style={{ gridArea: "1 / 1" }}>
            <WorktreeChanges
              key={`${sessionId}:${worktreePath}`}
              worktreePath={worktreePath}
              onChangesLoaded={handleWorktreeLoaded}
            />
          </div>
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
          className="flex min-h-0 flex-col"
          style={{
            gridArea: "1 / 1",
            visibility: showChanges ? "hidden" : "visible",
          }}
          aria-hidden={showChanges}
          inert={showChanges}
        >
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
          <Profiler
            id={`${sessionId}-transcript`}
            onRender={() => renderObserver?.("transcript")}
          >
            <ChatMessages
              sessionId={sessionId}
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
              footer={
                gate && gateStatus && gateDraft ? (
                  <GateSteering
                    sessionId={sessionId}
                    gate={gate}
                    status={gateStatus}
                    draft={gateDraft}
                  />
                ) : null
              }
            />
          </Profiler>
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
    <DiffReviewContext.Provider value={diffReview}>
      {content}
    </DiffReviewContext.Provider>
  );
}
