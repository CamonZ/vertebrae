import { useInlineScrollFollow } from "./useInlineScrollFollow";
import { getProjectScopeGeneration } from "../../stores/projectScopedStores";
import { findDiscussionSession } from "./restoreSelectionDiscussions";
import { useSelectionDiscussionCatalog } from "./useSelectionDiscussionCatalog";
import { useUIStore } from "../../stores/uiStore";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { useDiscussionModel } from "../../hooks/useDiscussionModel";
import {
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { commands, type LocalChatHarnessKind } from "../../bindings";
import { errorMessage } from "../../query/commandResult";
import {
  reviewLocation,
  reviewRange,
  supportsInlineDiscussion,
  unwrapAnchor,
} from "./reviewAnchors";
import {
  getLocalChatLifecycle,
  isLocalChatLifecycleBusy,
  useChatStore,
  type ActiveChatTurn,
} from "../../stores/chatStore";
import {
  currentBackendSessionId,
  doCloseSession,
} from "../../hooks/useLocalChat";
import { deliverLocalChatTurn } from "../../hooks/localChatTurnDelivery";
import {
  SelectionDiscussions,
  anchorNotice,
  anchorsInChanges,
  isOutdated,
  discussionTurn,
  selectionLabel,
  type CodeSelection,
  type DiscussionState,
} from "./selectionDiscussions";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";
import { ChatTranscript } from "./ChatMessages";
import { collapseTurns, earlierTurnsLabel } from "./discussionTurns";
import {
  DISCUSSION_ASK_SHORTCUT,
  DISCUSSION_COLLAPSE_SHORTCUT,
  DISCUSSION_SEND_SHORTCUT,
  DISCUSSION_OPEN_KEY,
  matchesChatShortcut,
  shortcutText,
} from "./chatShortcuts";
import {
  SelectionDiscussionModelContext,
  SelectionDiscussionContext,
  SelectionDiscussionActionsContext,
  SelectionDiscussionAnchorsContext,
  SelectionDiscussionSelectionContext,
  type DiscussionActions,
  type DiscussionValue,
} from "./selectionDiscussionState";
import { focusKeepProps } from "../../utils/focusKeep";
import { useKeepFocus } from "../../hooks/useKeepFocus";
import { OWNS_ESCAPE_ATTRIBUTE } from "../../hooks/useGlassPanel";

export function SelectionDiscussionProvider({
  children,
  controller,
  worktreePath,
  parentChatId,
  projectPath,
  harness,
  providerId,
  modelId,
  reasoningEffort,
  speedTier,
  personality,
  onOpen,
  onAttach,
  snapshot,
}: {
  children: ReactNode;
  /** The chat's controller (`useChatDiscussions`). */
  controller: SelectionDiscussions;
  worktreePath: string;
  /**
   * The chat's last loaded review snapshot. Threads re-anchor against it
   * whether or not any discussion UI is mounted.
   */
  snapshot: WorktreeSnapshot | null;
  parentChatId?: string;
  projectPath?: string | null;
  harness: LocalChatHarnessKind;
  providerId?: string;
  modelId?: string | null;
  reasoningEffort?: string | null;
  speedTier?: string | null;
  personality?: string | null;
  /** Show the chat's Changes, where an inline thread's anchor is. */
  onOpen(): void;
  onAttach(anchor: CodeSelection, outdated?: boolean, question?: string): void;
}) {
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  );

  const [readyWorktree, setReadyWorktree] = useState<string | null>(null);
  const [anchorError, setAnchorError] = useState<string | null>(null);
  const [mappingError, setMappingError] = useState<string | null>(null);
  // Presentation only: collapsing never touches a thread's session.
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(
    () => new Set()
  );
  const [focusRequest, setFocusRequest] = useState<string | null>(null);
  const capabilityVersion = useRef(0);
  const snapshotRef = useRef<WorktreeSnapshot | null>(null);
  const capturing = useRef(false);
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const checkAvailability = useCallback(async () => {
    const version = ++capabilityVersion.current;
    if (!parentChatId || !worktreePath) return;
    let ready = false;
    try {
      await unwrapAnchor(commands.checkReviewAnchorWorktree(worktreePath));
      ready = true;
    } catch {
      // A non-Git folder and an unborn branch are normal capability states.
    }
    if (mounted.current && capabilityVersion.current === version) {
      setReadyWorktree(ready ? worktreePath : null);
    }
  }, [parentChatId, worktreePath]);

  useEffect(() => {
    void checkAvailability();
    const onFocus = () => void checkAvailability();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [checkAvailability]);

  const canAskFullFile = !!parentChatId && !!projectPath;
  const canAsk = canAskFullFile && readyWorktree === worktreePath;

  const mainSelection = {
    harness,
    providerId,
    modelId,
    reasoningEffort,
    speedTier,
    personality,
  };
  const hasDiscussionContext =
    state.selection !== null || state.threads.length > 0;
  const choice = useDiscussionModel(mainSelection, hasDiscussionContext);

  const callbacks = useRef({ onOpen, onAttach });
  callbacks.current = { onOpen, onAttach };

  // Only the active thread keeps an idle process; a collapsed thread closes
  // it once its reply settles and resumes the conversation on the next ask.
  useEffect(() => {
    const closing = new Set<string>();
    const closeInactive = () => {
      const { sessions } = useChatStore.getState();
      const { threads, activeId } = controller.getSnapshot();

      for (const thread of threads) {
        const session = thread.sessionId && sessions[thread.sessionId];

        if (
          thread.id !== activeId &&
          session &&
          session.backendSessionId &&
          getLocalChatLifecycle(session) === "idle" &&
          !closing.has(session.backendSessionId)
        ) {
          // Closing writes to the store, which re-enters this subscription.
          const backendSessionId = session.backendSessionId;

          closing.add(backendSessionId);
          void closeProcess(session.id, backendSessionId).finally(() =>
            closing.delete(backendSessionId)
          );
        }
      }
    };
    const unsubscribe = [
      controller.subscribe(closeInactive),
      useChatStore.subscribe(closeInactive),
    ];

    closeInactive();
    return () => unsubscribe.forEach((unsubscribe) => unsubscribe());
  }, [controller]);

  // A bound session keeps its conversation after the worktree closes.
  useEffect(
    () => () => {
      const store = useChatStore.getState();

      for (const thread of controller.getSnapshot().threads) {
        const session = thread.sessionId && store.sessions[thread.sessionId];
        if (!session) continue;

        if (session.backendSessionId)
          void closeProcess(session.id, session.backendSessionId);
      }
    },
    [controller]
  );

  const reportCatalogError = useCallback((error: unknown) => {
    if (mounted.current) setAnchorError(errorMessage(error));
  }, []);
  const reportMapping = useCallback((error: unknown | null) => {
    setMappingError(error === null ? null : errorMessage(error));
  }, []);
  const { mapSnapshot, noteWriter, comparison } = useSelectionDiscussionCatalog(
    {
      controller,
      projectPath,
      parentChatId,
      worktreePath,
      report: reportCatalogError,
      reportMapping,
    }
  );
  const reconcile = useCallback(
    (snapshot: WorktreeSnapshot) => {
      const changed = snapshotRef.current !== snapshot;
      snapshotRef.current = snapshot;
      controller.reconcile(snapshot);
      if (changed) void checkAvailability();
      mapSnapshot(snapshot);
    },
    [checkAvailability, controller, mapSnapshot]
  );
  // Runs with the review snapshot rather than re-reading files per thread.
  // Owned here, not by a rendering component, so closing or never opening
  // the side column does not stop re-anchoring (db5160ff).
  const reconcileRef = useRef(reconcile);
  reconcileRef.current = reconcile;
  useEffect(() => {
    if (snapshot) reconcileRef.current(snapshot);
  }, [snapshot]);

  const send = useCallback(
    async (id: string, text: string) => {
      // Snapshot the selected provider/model before any asynchronous setup.
      const thread = controller.thread(id);
      const question = text.trim();
      if (
        choice.error !== null ||
        !thread ||
        thread.status.kind === "unreadable" ||
        !question ||
        !parentChatId ||
        !projectPath
      )
        return;

      const checkout = thread.anchor.fullFile?.checkout ?? worktreePath;
      const store = useChatStore.getState();
      const session =
        (thread.sessionId ? store.sessions[thread.sessionId] : undefined) ??
        findDiscussionSession(
          Object.values(store.sessions),
          { projectPath, parentChatId, worktreePath: checkout },
          id
        );
      // One turn at a time, and never into a process that is closing.
      if (
        session &&
        (session.activeTurn ||
          isLocalChatLifecycleBusy(getLocalChatLifecycle(session)))
      )
        return;

      const sameProvider =
        session?.harness === choice.harness &&
        (session.providerId ?? null) === (choice.providerId ?? null);
      const applyChoice = !session || sameProvider;
      const sessionId =
        session?.id ??
        store.openDiscussionSession({
          harness: choice.harness,
          providerId: choice.providerId,
          projectPath,
          discussionBinding: {
            parentChatId,
            reviewThreadId: id,
            worktreePath: checkout,
          },
        });
      if (applyChoice) {
        store.setSessionSelectedModel(sessionId, choice.modelId);
        store.setSessionReasoningEffort(sessionId, choice.reasoningEffort);
        store.setSessionSpeedTier(sessionId, choice.speedTier);
        store.setSessionPersonality(sessionId, choice.personality);
      }

      const continues =
        !!session && (!!session.backendSessionId || !!session.providerResumeId);
      const turn = discussionTurn(thread, continues, question);

      controller.sent(id, sessionId, false);
      const writer = noteWriter();
      store.addMessage(sessionId, {
        kind: "user",
        text: question,
        timestamp: new Date().toISOString(),
      });
      const delivered = await deliverLocalChatTurn(sessionId, turn.payload);
      if (delivered && turn.notesOutdated) {
        if (mounted.current && controller.thread(id))
          controller.sent(id, sessionId, true);
        void writer?.(id);
      }

      // Cancelled while the process started: stop its turn now it exists.
      const started = useChatStore.getState().sessions[sessionId];
      if (started?.activeTurn?.phase === "stopping" && started.backendSessionId)
        void interrupt(sessionId, started.backendSessionId);
    },
    [controller, choice, noteWriter, parentChatId, projectPath, worktreePath]
  );

  const cancel = useCallback(
    (id: string) => {
      const sessionId = controller.thread(id)?.sessionId;
      const store = useChatStore.getState();
      const session = sessionId ? store.sessions[sessionId] : undefined;
      if (!session || !store.markActiveTurnStopping(session.id)) return;

      // A process still starting is interrupted once its creation returns.
      const lifecycle = getLocalChatLifecycle(session);
      if (lifecycle === "starting" || lifecycle === "resuming") return;
      if (session.backendSessionId)
        void interrupt(session.id, session.backendSessionId);
    },
    [controller]
  );

  const begin = useCallback(
    async (anchor: CodeSelection, question?: string) => {
      if (
        !(anchor.fullFile ? canAskFullFile : canAsk) ||
        !parentChatId ||
        !projectPath ||
        capturing.current ||
        !supportsInlineDiscussion(anchor)
      )
        return false;
      capturing.current = true;
      setAnchorError(null);
      // Where the user asked from (the draft composer or its button).
      const origin = document.activeElement;
      const id = crypto.randomUUID();
      const generation = getProjectScopeGeneration();
      try {
        const capture = await unwrapAnchor(
          commands.captureReviewAnchor({
            worktree: anchor.fullFile?.checkout ?? worktreePath,
            threadId: id,
            location: reviewLocation(anchor, parentChatId, comparison()),
            range: reviewRange(anchor),
            selectedText: anchor.code,
            parent: { chatId: parentChatId, projectPath },
          })
        );
        if (!mounted.current || generation !== getProjectScopeGeneration())
          return false;
        controller.ask(anchor, id, capture);
        // The draft the user typed in gives way to the discussion's composer,
        // unless they moved focus elsewhere while the anchor was captured.
        const active = document.activeElement;
        if (active === origin || !active || active === document.body)
          setFocusRequest(id);
      } catch (error) {
        if (generation === getProjectScopeGeneration())
          reportCatalogError(error);
        return false;
      } finally {
        capturing.current = false;
      }
      if (question) {
        void send(id, question).catch((error: unknown) => {
          if (mounted.current) setAnchorError(errorMessage(error));
        });
      }
      return true;
    },
    [
      canAsk,
      canAskFullFile,
      comparison,
      controller,
      parentChatId,
      projectPath,
      reportCatalogError,
      send,
      worktreePath,
    ]
  );

  const actions = useMemo<DiscussionActions>(
    () => ({
      canAsk,
      canAskFullFile,
      select: (anchor) => {
        controller.select(anchor);
        if (anchor) void checkAvailability();
      },
      discuss: begin,
      attach: (...args) => callbacks.current.onAttach(...args),
      reopen: (id, options) => {
        controller.reopen(id);
        setFocusRequest(id && options?.focus ? id : null);
        const thread = id ? controller.thread(id) : undefined;

        if (!options?.inPlace && thread && anchorsInChanges(thread.anchor))
          callbacks.current.onOpen();
        if (thread?.sessionId) {
          const store = useChatStore.getState();
          const session = store.sessions[thread.sessionId];
          if (session && !session.backendSessionId && !session.messages.length)
            store.refreshProviderThreadSession(session.id);
        }
      },
      send: (id, text) => {
        void send(id, text);
      },
      cancel,
      reconcile,
      toggleCollapsed: (id) =>
        setCollapsed((current) => {
          const next = new Set(current);
          if (!next.delete(id)) next.add(id);
          return next;
        }),
      focusTaken: (id) =>
        setFocusRequest((current) => (current === id ? null : current)),
    }),
    [
      controller,
      send,
      cancel,
      canAsk,
      canAskFullFile,
      begin,
      reconcile,
      checkAvailability,
    ]
  );

  const unreadable = state.threads.find(
    ({ status, anchor }) =>
      status.kind === "unreadable" && !anchor.fullFile?.turn
  )?.status;
  const readError =
    unreadable?.kind === "unreadable" ? unreadable.message : null;
  const value = useMemo<DiscussionValue>(
    () => ({
      ...state,
      ...actions,
      collapsed,
      focusRequest,
      projectPath: worktreePath,
      anchorError: anchorError ?? readError ?? mappingError,
    }),
    [
      state,
      actions,
      collapsed,
      focusRequest,
      worktreePath,
      anchorError,
      readError,
      mappingError,
    ]
  );

  return (
    <SelectionDiscussionModelContext.Provider value={choice}>
      <SelectionDiscussionActionsContext.Provider value={actions}>
        <SelectionDiscussionAnchorsContext.Provider
          value={controller.getAnchors()}
        >
          <SelectionDiscussionSelectionContext.Provider value={state.selection}>
            <SelectionDiscussionContext.Provider value={value}>
              {children}
            </SelectionDiscussionContext.Provider>
          </SelectionDiscussionSelectionContext.Provider>
        </SelectionDiscussionAnchorsContext.Provider>
      </SelectionDiscussionActionsContext.Provider>
    </SelectionDiscussionModelContext.Provider>
  );
}

/** Interrupt the in-flight turn; the process and conversation stay live. */
async function interrupt(sessionId: string, backendSessionId: string) {
  const localId =
    useChatStore.getState().sessions[sessionId]?.activeTurn?.localId;
  const result = await commands
    .interruptLocalChatTurn(backendSessionId)
    .catch(() => null);

  if (result?.status !== "ok" && localId)
    useChatStore.getState().restoreActiveTurn(sessionId, localId);
}

/** Close an idle process, keeping the session so the next ask resumes it. */
function closeProcess(sessionId: string, backendSessionId: string) {
  const store = useChatStore.getState();

  return doCloseSession(backendSessionId, sessionId, {
    markSessionClosed: (id) => store.setSessionLifecycle(id, "idle"),
    setSessionLifecycle: store.setSessionLifecycle,
    setBackendSessionId: store.setBackendSessionId,
    getBackendSessionId: currentBackendSessionId,
    clearStreamingAssistant: store.clearStreamingAssistant,
    settleActiveTurn: store.settleActiveTurn,
  });
}

const collapseKeys = shortcutText(DISCUSSION_COLLAPSE_SHORTCUT);
const askKeys = shortcutText(DISCUSSION_ASK_SHORTCUT);
const sendKeys = shortcutText(DISCUSSION_SEND_SHORTCUT);

/**
 * Rendered in the diff annotation at the thread's anchor, never in a footer.
 * `onClosed` returns focus to the anchor line after the thread closes.
 */
export function InlineSelectionDiscussion({
  threadId,
  onClosed,
}: {
  threadId: string;
  onClosed?(anchor: CodeSelection): void;
}) {
  const discussion = useContext(SelectionDiscussionContext);
  const thread = discussion?.threads.find((thread) => thread.id === threadId);
  if (!thread || !discussion) return null;
  const notice = anchorNotice(thread.status);

  return discussion.activeId === thread.id ? (
    <MiniThread
      key={thread.id}
      thread={thread}
      discussion={discussion}
      onClosed={thread.status.kind === "inline" ? onClosed : undefined}
    />
  ) : (
    <button
      type="button"
      className="selection-mini-marker"
      aria-label="Reopen selection discussion"
      title={`Open discussion (${DISCUSSION_OPEN_KEY.toUpperCase()} on its line)`}
      aria-keyshortcuts={DISCUSSION_OPEN_KEY}
      onClick={() => discussion.reopen(thread.id, { focus: true })}
    >
      Discussion · {selectionLabel(thread.anchor)}
      {notice && ` · ${notice.marker}`}
    </button>
  );
}

/** An open discussion: its transcript, composer and turn controls. */
export function MiniThread({
  thread,
  discussion,
  onClosed,
}: {
  thread: DiscussionState["threads"][number];
  discussion: DiscussionValue;
  onClosed?(anchor: CodeSelection): void;
}) {
  const [question, setQuestion] = useState("");
  const composerRef = useRef<HTMLTextAreaElement>(null);
  useKeepFocus(composerRef);
  const thinkingStyle = useUIStore((state) => state.thinkingIndicatorStyle);
  const choice = useContext(SelectionDiscussionModelContext);
  const session = useChatStore((state) =>
    thread.sessionId ? state.sessions[thread.sessionId] : undefined
  );

  const activeTurn = session?.activeTurn ?? null;
  const cardRef = useInlineScrollFollow(activeTurn?.localId);
  const failed = getLocalChatLifecycle(session) === "error";
  const announcement = useTurnAnnouncement(activeTurn, failed);
  const notice = anchorNotice(thread.status);

  // Opening from the keyboard puts the caret in the composer, once. Opening
  // also highlights the anchor, and the diff re-renders its rows a frame
  // later, which can blur the slotted composer; focus again after that.
  const { focusRequest, focusTaken } = discussion;
  useEffect(() => {
    if (focusRequest !== thread.id) return;
    const focus = () => {
      const composer = composerRef.current;
      if (composer && document.activeElement !== composer) composer.focus();
    };
    focus();
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => {
        focus();
        focusTaken(thread.id);
      });
    });
    return () => cancelAnimationFrame(frame);
  }, [focusRequest, focusTaken, thread.id]);

  const collapsed = discussion.collapsed.has(thread.id);
  const turns = collapsed && session ? collapseTurns(session.messages) : null;
  const hidden = turns && turns.earlier > 0 ? turns : null;
  const toggleCollapsed = () => discussion.toggleCollapsed(thread.id);
  const close = () => {
    discussion.reopen(null);
    onClosed?.(thread.anchor);
  };
  const unreadable = thread.status.kind === "unreadable";
  const canAsk =
    !unreadable && !activeTurn && !!question.trim() && !choice?.error;
  const ask = () => {
    if (!canAsk) return;
    discussion.send(thread.id, question);
    setQuestion("");
  };
  const sendToMain = () => {
    if (unreadable) return;
    discussion.attach(thread.anchor, isOutdated(thread), question);
    setQuestion("");
  };

  return (
    <section
      ref={cardRef}
      className="selection-mini-thread"
      aria-label="Selection discussion"
      data-testid="selection-mini-thread"
      // Esc closes this thread, not the chat workspace around it.
      {...{ [OWNS_ESCAPE_ATTRIBUTE]: "" }}
      onKeyDown={(event) => {
        if (event.defaultPrevented || event.nativeEvent.isComposing) return;
        if (matchesChatShortcut(event, DISCUSSION_COLLAPSE_SHORTCUT)) {
          event.preventDefault();
          if (!event.repeat) toggleCollapsed();
          return;
        }
        const plain =
          !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey;
        if (event.key !== "Escape" || !plain) return;
        event.preventDefault();
        close();
      }}
      onClick={(event) => {
        if (
          thread.status.kind !== "inline" ||
          event.currentTarget.ownerDocument.getSelection()?.isCollapsed ===
            false ||
          (event.target instanceof Element &&
            event.target.closest("button, a, input, textarea, select, pre"))
        )
          return;
        discussion.select(thread.anchor);
      }}
    >
      <header className="selection-mini-header">
        <button
          type="button"
          className="selection-mini-anchor"
          disabled={thread.status.kind !== "inline"}
          aria-label={`Highlight selected code: ${selectionLabel(thread.anchor)}`}
          title="Highlight selected code"
          onClick={() => discussion.select(thread.anchor)}
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
            <path d="m8 8-4 4 4 4m8-8 4 4-4 4m-3-10-2 20" />
          </svg>
          <span>{selectionLabel(thread.anchor)}</span>
        </button>
        <span className="selection-mini-badge">Read only</span>
        {notice && (
          <span className="selection-mini-outdated" role="status">
            {notice.label}
          </span>
        )}
        <button
          type="button"
          className="selection-mini-close"
          aria-label={
            collapsed ? "Show all turns" : "Show only the latest response"
          }
          aria-pressed={collapsed}
          aria-keyshortcuts="Meta+Shift+E"
          title={`${collapsed ? "Show all turns" : "Show only the latest response"} (${collapseKeys})`}
          onClick={toggleCollapsed}
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
            <path
              d={
                collapsed
                  ? "m7 9 5-5 5 5M7 15l5 5 5-5"
                  : "m7 4 5 5 5-5M7 20l5-5 5 5"
              }
            />
          </svg>
        </button>
        <button
          type="button"
          className="selection-mini-close"
          aria-label="Close discussion"
          aria-keyshortcuts="Escape"
          title="Close discussion (Esc)"
          onClick={close}
        >
          <svg
            width="16"
            height="16"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            aria-hidden="true"
          >
            <path d="m6 6 12 12M6 18 18 6" />
          </svg>
        </button>
      </header>
      {thread.status.kind !== "inline" &&
        thread.status.kind !== "unreadable" && (
          <pre aria-label="Original selected code">
            {thread.git.original.code}
          </pre>
        )}
      <DiscussionModelNotice />
      <div className="selection-mini-messages">
        {hidden && (
          <button
            type="button"
            className="selection-mini-earlier"
            title={`Show all turns (${collapseKeys})`}
            onClick={toggleCollapsed}
          >
            <span aria-hidden="true">▸</span>
            {earlierTurnsLabel(hidden.earlier)}
          </button>
        )}
        {session && (
          <ChatTranscript
            sessionId={session.id}
            messages={hidden?.latest ?? session.messages}
            // Discussions show no model labels; the composer owns that choice.
            assistantLabel="Assistant"
            isActive={!!session.backendSessionId}
            streamingAssistant={session.streamingAssistant ?? null}
          />
        )}
      </div>
      {activeTurn && (
        <div className="selection-mini-thinking">
          <ThinkingIndicator
            label={activeTurn.phase === "stopping" ? "Stopping..." : undefined}
            style={thinkingStyle}
          />
        </div>
      )}
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {announcement}
      </p>
      {failed && <p role="alert">Discussion failed.</p>}
      <form
        className="diff-comment-editor selection-mini-composer"
        onSubmit={(event) => {
          event.preventDefault();
          ask();
        }}
      >
        <textarea
          ref={composerRef}
          {...focusKeepProps}
          aria-label="Ask about selected code"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          placeholder="Ask a follow-up question…"
          onKeyDown={(event) => {
            if (event.nativeEvent.isComposing) return;
            if (event.key !== "Enter" || !(event.metaKey || event.ctrlKey))
              return;
            event.preventDefault();
            if (event.repeat) return;
            if (event.shiftKey) sendToMain();
            else ask();
          }}
        />
        <div className="diff-comment-editor-actions selection-mini-actions">
          {activeTurn && (
            <button
              type="button"
              disabled={activeTurn.phase === "stopping"}
              onClick={() => discussion.cancel(thread.id)}
            >
              Cancel response
            </button>
          )}
          <button
            type="button"
            disabled={unreadable}
            title={`Send to main chat (${sendKeys})`}
            aria-keyshortcuts="Meta+Shift+Enter"
            onClick={sendToMain}
          >
            Send to main chat
          </button>
          <button
            type="submit"
            data-primary
            disabled={!canAsk}
            title={`Ask (${askKeys})`}
            aria-keyshortcuts="Meta+Enter"
          >
            Ask
          </button>
        </div>
      </form>
    </section>
  );
}

/** Screen-reader status for the end of each turn. */
function useTurnAnnouncement(
  activeTurn: ActiveChatTurn | null,
  failed: boolean
): string {
  const [announcement, setAnnouncement] = useState("");
  const previous = useRef(activeTurn);

  useEffect(() => {
    const ended = previous.current;
    previous.current = activeTurn;

    if (activeTurn) setAnnouncement("");
    else if (ended)
      setAnnouncement(
        failed
          ? "Discussion failed."
          : ended.phase === "stopping"
            ? "Reply cancelled."
            : "Reply complete."
      );
  }, [activeTurn, failed]);

  return announcement;
}

/** Shared by the initial comment dialog and each follow-up composer. */
export function DiscussionModelNotice() {
  const choice = useContext(SelectionDiscussionModelContext);

  if (!choice?.error) return null;

  // "<reason> Open Settings → … to choose …": the reason leads, the path to
  // fix it follows as a quieter second clause.
  const at = choice.error.indexOf("Open Settings");
  const reason = at > 0 ? choice.error.slice(0, at).trim() : choice.error;
  const fix = at > 0 ? choice.error.slice(at) : "";

  return (
    <p role="alert" className="selection-model-notice" data-tone="warn">
      <span className="selection-model-notice-dot" aria-hidden="true" />
      <span className="selection-model-notice-text">
        <span>{reason}</span>
        {fix && <span className="selection-model-notice-fix"> {fix}</span>}
      </span>
    </p>
  );
}
