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
import { deliverLocalChatTurn } from "../../hooks/useLocalChatEventRouter";
import {
  SelectionDiscussions,
  discussionTurn,
  selectionLabel,
  type CodeSelection,
  type DiscussionState,
} from "./selectionDiscussions";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";
import { ChatTranscript } from "./ChatMessages";
import {
  SelectionDiscussionModelContext,
  SelectionDiscussionContext,
  SelectionDiscussionActionsContext,
  SelectionDiscussionAnchorsContext,
  SelectionDiscussionSelectionContext,
  type DiscussionActions,
  type DiscussionValue,
} from "./selectionDiscussionState";

export function SelectionDiscussionProvider({
  children,
  worktreePath,
  harness,
  providerId,
  modelId,
  reasoningEffort,
  speedTier,
  personality,
  onOpen,
  onAttach,
}: {
  children: ReactNode;
  worktreePath: string;
  harness: LocalChatHarnessKind;
  providerId?: string;
  modelId?: string | null;
  reasoningEffort?: string | null;
  speedTier?: string | null;
  personality?: string | null;
  onOpen(): void;
  onAttach(anchor: CodeSelection, outdated?: boolean, question?: string): void;
}) {
  const [controller] = useState(() => new SelectionDiscussions());
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  );

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

  // Discussions live as long as the provider: unmounting (a session or
  // worktree switch) closes their processes and discards their sessions.
  useEffect(
    () => () => {
      const store = useChatStore.getState();

      for (const thread of controller.getSnapshot().threads) {
        const session = thread.sessionId && store.sessions[thread.sessionId];
        if (!session) continue;

        if (session.backendSessionId)
          void commands
            .closeLocalChatSession(session.backendSessionId)
            .catch(() => {});
        store.closeSession(session.id);
      }
    },
    [controller]
  );

  const send = useCallback(
    async (id: string, text: string) => {
      // Snapshot the selected provider/model before any asynchronous setup.
      const thread = controller.thread(id);
      const question = text.trim();
      if (choice.error !== null || !thread || !question) return;

      const store = useChatStore.getState();
      let session = thread.sessionId
        ? store.sessions[thread.sessionId]
        : undefined;
      // One turn at a time, and never into a process that is closing.
      if (
        session &&
        (session.activeTurn ||
          isLocalChatLifecycleBusy(getLocalChatLifecycle(session)))
      )
        return;

      // A conversation cannot move to another provider: start a new one.
      if (
        session &&
        (session.harness !== choice.harness ||
          (session.providerId ?? null) !== (choice.providerId ?? null))
      ) {
        if (session.backendSessionId)
          void commands
            .closeLocalChatSession(session.backendSessionId)
            .catch(() => {});
        store.closeSession(session.id);
        session = undefined;
      }

      const sessionId =
        session?.id ??
        store.openDiscussionSession({
          harness: choice.harness,
          providerId: choice.providerId,
          projectPath: worktreePath,
        });
      store.setSessionSelectedModel(sessionId, choice.modelId);
      store.setSessionReasoningEffort(sessionId, choice.reasoningEffort);
      store.setSessionSpeedTier(sessionId, choice.speedTier);
      store.setSessionPersonality(sessionId, choice.personality);

      const continues =
        !!session && (!!session.backendSessionId || !!session.providerResumeId);
      const turn = discussionTurn(thread, continues, question);

      controller.sent(id, sessionId, turn.notesOutdated);
      store.addMessage(sessionId, {
        kind: "user",
        text: question,
        timestamp: new Date().toISOString(),
      });
      await deliverLocalChatTurn(sessionId, turn.payload);

      // Cancelled while the process started: stop its turn now it exists.
      const started = useChatStore.getState().sessions[sessionId];
      if (started?.activeTurn?.phase === "stopping" && started.backendSessionId)
        void interrupt(sessionId, started.backendSessionId);
    },
    [controller, choice, worktreePath]
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

  const actions = useMemo<DiscussionActions>(
    () => ({
      select: (anchor) => controller.select(anchor),
      ask: () => {
        controller.ask();
      },
      discuss: (anchor, question) => {
        controller.select(anchor);
        const id = controller.ask();

        if (id) void send(id, question);
      },
      attach: (...args) => callbacks.current.onAttach(...args),
      reopen: (id) => {
        controller.reopen(id);
        const thread = id ? controller.thread(id) : undefined;

        if (thread?.anchor.home.kind === "worktree") callbacks.current.onOpen();
      },
      send: (id, text) => {
        void send(id, text);
      },
      cancel,
      reconcile: (snapshot) => controller.reconcile(snapshot),
    }),
    [controller, send, cancel]
  );

  const value = useMemo<DiscussionValue>(
    () => ({ ...state, ...actions, projectPath: worktreePath }),
    [state, actions, worktreePath]
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
  });
}

/** Rendered in the diff annotation at the thread's anchor, never in a footer. */
export function InlineSelectionDiscussion({ threadId }: { threadId: string }) {
  const discussion = useContext(SelectionDiscussionContext);
  const thread = discussion?.threads.find((thread) => thread.id === threadId);
  if (!thread || !discussion) return null;

  return discussion.activeId === thread.id ? (
    <MiniThread key={thread.id} thread={thread} discussion={discussion} />
  ) : (
    <button
      type="button"
      className="selection-mini-marker"
      aria-label="Reopen selection discussion"
      onClick={() => discussion.reopen(thread.id)}
    >
      Discussion · {selectionLabel(thread.anchor)}
      {thread.outdated ? " · outdated" : ""}
    </button>
  );
}

function MiniThread({
  thread,
  discussion,
}: {
  thread: DiscussionState["threads"][number];
  discussion: DiscussionValue;
}) {
  const [question, setQuestion] = useState("");
  const thinkingStyle = useUIStore((state) => state.thinkingIndicatorStyle);
  const choice = useContext(SelectionDiscussionModelContext);
  const session = useChatStore((state) =>
    thread.sessionId ? state.sessions[thread.sessionId] : undefined
  );

  const activeTurn = session?.activeTurn ?? null;
  const failed = getLocalChatLifecycle(session) === "error";
  const announcement = useTurnAnnouncement(activeTurn, failed);

  return (
    <section
      className="selection-mini-thread"
      aria-label="Selection discussion"
      data-testid="selection-mini-thread"
      onClick={(event) => {
        if (
          event.target instanceof Element &&
          event.target.closest("button, a, input, textarea, select, pre")
        )
          return;
        discussion.select(thread.anchor);
      }}
    >
      <header className="selection-mini-header">
        <button
          type="button"
          className="selection-mini-anchor"
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
        {thread.outdated && (
          <span className="selection-mini-outdated" role="status">
            Outdated context
          </span>
        )}
        <button
          type="button"
          className="selection-mini-close"
          aria-label="Close discussion"
          title="Close discussion"
          onClick={() => discussion.reopen(null)}
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
      <DiscussionModelNotice />
      <div className="selection-mini-messages">
        {session && (
          <ChatTranscript
            sessionId={session.id}
            messages={session.messages}
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
          if (choice?.error) return;
          discussion.send(thread.id, question);
          setQuestion("");
        }}
      >
        <textarea
          aria-label="Ask about selected code"
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          rows={3}
          placeholder="Ask a follow-up question…"
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
            onClick={() => {
              discussion.attach(thread.anchor, thread.outdated, question);
              setQuestion("");
            }}
          >
            Send to main chat
          </button>
          <button
            type="submit"
            disabled={!!activeTurn || !question.trim() || !!choice?.error}
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

/** Runs with the review snapshot rather than re-reading files for a thread. */
export function DiscussionSnapshot({
  snapshot,
}: {
  snapshot: WorktreeSnapshot | null;
}) {
  const discussion = useContext(SelectionDiscussionContext);
  const reconcile = useRef(discussion?.reconcile);
  reconcile.current = discussion?.reconcile;

  useEffect(() => {
    if (snapshot) reconcile.current?.(snapshot);
  }, [snapshot]);

  return null;
}

/** Shared by the initial comment dialog and each follow-up composer. */
export function DiscussionModelNotice() {
  const choice = useContext(SelectionDiscussionModelContext);

  if (!choice?.error) return null;

  return (
    <p role="alert" className="selection-model-notice">
      {choice.error}
    </p>
  );
}
