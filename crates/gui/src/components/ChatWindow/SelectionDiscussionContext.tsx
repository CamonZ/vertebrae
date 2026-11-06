import { MarkdownContent } from "../shared/MarkdownContent";
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
import { commands, events, type LocalChatHarnessKind } from "../../bindings";
import {
  SelectionDiscussions,
  discussionPrompt,
  selectionLabel,
  type CodeSelection,
  type DiscussionState,
} from "./selectionDiscussions";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";
import {
  SelectionDiscussionContext,
  SelectionDiscussionActionsContext,
  SelectionDiscussionAnchorsContext,
  SelectionDiscussionSelectionContext,
  discussionErrorCategory,
  discussionErrorMessage,
  type DiscussionActions,
  type DiscussionValue,
} from "./selectionDiscussionState";

export function SelectionDiscussionProvider({
  children,
  worktreePath,
  harness,
  providerId,
  modelId,
  onOpen,
  onAttach,
}: {
  children: ReactNode;
  worktreePath: string;
  harness: LocalChatHarnessKind;
  providerId?: string;
  modelId?: string | null;
  onOpen(): void;
  onAttach(anchor: CodeSelection, outdated?: boolean, question?: string): void;
}) {
  const [controller] = useState(() => new SelectionDiscussions());
  const state = useSyncExternalStore(
    controller.subscribe,
    controller.getSnapshot
  );
  const cleanups = useRef(new Map<string, () => void>());
  const callbacks = useRef({ onOpen, onAttach });
  callbacks.current = { onOpen, onAttach };

  useEffect(() => {
    const requests = cleanups.current;

    return () => {
      for (const cleanup of requests.values()) cleanup();
      requests.clear();
    };
  }, []);

  const cancel = useCallback(
    (id: string) => {
      controller.cancel(id);
      cleanups.current.get(id)?.();
    },
    [controller]
  );

  const send = useCallback(
    async (id: string, text: string) => {
      const thread = controller.begin(id, text);
      if (!thread?.requestId) return;

      const requestId = thread.requestId;
      let retired = false;
      let created = false;
      const unlisteners: (() => void)[] = [];

      const cleanup = () => {
        if (retired) return;

        retired = true;
        const listeners = unlisteners.splice(0);
        listeners.forEach((unlisten) => unlisten());
        cleanups.current.delete(id);
        if (created)
          void commands.closeLocalChatSession(requestId).catch(() => {});
      };
      cleanups.current.set(id, cleanup);

      const finish = (error: string | null = null) => {
        if (!retired) controller.finish(id, requestId, error);
        cleanup();
      };

      const fail = (error: unknown) => {
        if (retired) return;

        // Keep provider payloads and selected code out of diagnostics.
        const category = discussionErrorCategory(error);
        const message = discussionErrorMessage(error);

        console.warn("Selection discussion failed", {
          requestId,
          harness,
          category,
        });
        finish(message);
      };

      try {
        const textListener = events.localChatTextEvent.listen(({ payload }) => {
          if (
            !retired &&
            payload.backend_session_id === requestId &&
            payload.is_root !== false &&
            !payload.parent_tool_use_id
          )
            controller.receive(id, requestId, payload.text, payload.is_partial);
        });

        const endListener = events.localChatSessionEndEvent.listen(
          ({ payload }) => {
            if (
              payload.backend_session_id === requestId &&
              payload.is_root !== false
            ) {
              const snapshot = controller.getSnapshot();
              const current = snapshot.threads.find(
                (thread) => thread.id === id
              );

              if (
                !retired &&
                payload.result &&
                current?.messages.at(-1)?.role === "user"
              )
                controller.receive(id, requestId, payload.result, false);
              const error = payload.is_error ? "Discussion failed." : null;
              finish(error);
            }
          }
        );

        const errorListener = events.localChatSessionErrorEvent.listen(
          ({ payload }) => {
            if (
              payload.backend_session_id === requestId &&
              payload.is_root !== false
            )
              fail(payload.error);
          }
        );

        const registrations = await Promise.allSettled([
          textListener,
          endListener,
          errorListener,
        ]);

        for (const result of registrations)
          if (result.status === "fulfilled") {
            if (retired) result.value();
            else unlisteners.push(result.value);
          }

        const failure = registrations.find(
          (result) => result.status === "rejected"
        );
        if (failure?.status === "rejected") throw failure.reason;
        if (retired) return;

        const initialPrompt = discussionPrompt(thread);
        const sessionInput = {
          read_only: true,
          harness,
          backend_session_id: requestId,
          chat_session_id: requestId,
          working_dir: worktreePath,
          initial_prompt: initialPrompt,
          provider_resume_id: null,
          model_id: modelId ?? null,
          reasoning_effort: null,
          permission_mode: null,
          personality: null,
          provider_id: providerId,
        };
        const result = await commands.createLocalChatSession(sessionInput);

        created = result.status === "ok";
        if (retired && created) {
          void commands.closeLocalChatSession(requestId).catch(() => {});
          return;
        }

        if (result.status === "error") fail(result.error);
      } catch (error) {
        fail(error);
      }
    },
    [controller, harness, modelId, providerId, worktreePath]
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
        const snapshot = controller.getSnapshot();
        const thread = snapshot.threads.find((thread) => thread.id === id);

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
  );
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
      <div className="selection-mini-messages">
        {thread.messages.map((message, index) => (
          <article
            key={index}
            className={`selection-mini-message is-${message.role}`}
          >
            <div className="selection-mini-speaker">
              {message.role === "user" ? "You" : "Assistant"}
            </div>
            {message.role === "assistant" ? (
              <MarkdownContent
                text={message.text}
                projectPath={discussion.projectPath}
              />
            ) : (
              <p className="selection-mini-question">{message.text}</p>
            )}
          </article>
        ))}
      </div>
      <p
        className="sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        {thread.announcement}
      </p>
      {thread.error && <p role="alert">{thread.error}</p>}
      <form
        className="diff-comment-editor selection-mini-composer"
        onSubmit={(event) => {
          event.preventDefault();
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
          {thread.requestId && (
            <button type="button" onClick={() => discussion.cancel(thread.id)}>
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
            disabled={!!thread.requestId || !question.trim()}
          >
            Ask
          </button>
        </div>
      </form>
    </section>
  );
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
