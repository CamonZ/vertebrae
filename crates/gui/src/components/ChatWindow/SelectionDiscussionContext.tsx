import { getProjectScopeGeneration } from "../../stores/projectScopedStores";
import { findDiscussionSession } from "./restoreSelectionDiscussions";
import { useSelectionDiscussionCatalog } from "./useSelectionDiscussionCatalog";
import { useDiscussionModel } from "../../hooks/useDiscussionModel";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import {
  commands,
  type GithubReviewThread,
  type LocalChatHarnessKind,
} from "../../bindings";
import type { PendingGithubThreadComment } from "./assistantTextComments";
import {
  githubDiscussionAnchor,
  githubDiscussionContext,
  githubDiscussionTarget,
  githubThreadAttachment,
  githubThreadPlace,
  discussionPlace,
} from "./workspace/githubReview/githubDiscussion";
import type { PlacedThread } from "./workspace/githubReview/model";
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
} from "../../stores/chatStore";
import {
  currentBackendSessionId,
  doCloseSession,
} from "../../hooks/useLocalChat";
import { deliverLocalChatTurn } from "../../hooks/localChatTurnDelivery";
import {
  SelectionDiscussions,
  anchorsInChanges,
  isOutdated,
  discussionTurn,
  type CodeSelection,
} from "./selectionDiscussions";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";
import {
  SelectionDiscussionModelContext,
  SelectionDiscussionContext,
  SelectionDiscussionActionsContext,
  SelectionDiscussionAnchorsContext,
  SelectionDiscussionSelectionContext,
  type DiscussionActions,
  type DiscussionValue,
  type GithubDiscussResult,
} from "./selectionDiscussionState";

const OPENED: GithubDiscussResult = { opened: true };
const UNAVAILABLE: GithubDiscussResult = { opened: false, error: null };

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
  onAttachGithub,
  githubThreads,
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
  /** Send to main chat for a GitHub thread's discussion. */
  onAttachGithub?(comment: PendingGithubThreadComment): void;
  /** The PR's review threads as last read (`useWorktreePr`). */
  githubThreads?: readonly GithubReviewThread[];
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

  const callbacks = useRef({ onOpen, onAttach, onAttachGithub, githubThreads });
  callbacks.current = { onOpen, onAttach, onAttachGithub, githubThreads };
  const githubThread = useCallback(
    (id: string | null) =>
      id === null
        ? undefined
        : callbacks.current.githubThreads?.find((thread) => thread.id === id),
    []
  );

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
      const github = githubThread(thread.githubThreadId);
      const turn = discussionTurn(
        thread,
        continues,
        question,
        github && githubDiscussionContext(github)
      );

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
    [
      controller,
      choice,
      githubThread,
      noteWriter,
      parentChatId,
      projectPath,
      worktreePath,
    ]
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
            subject: { kind: "selection", selectedText: anchor.code },
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

  // A GitHub thread has one discussion: opening it again reopens that one.
  const discussGithub = useCallback(
    async (placed: PlacedThread) => {
      const existing = controller.forGithubThread(placed.thread.id);
      if (existing) {
        controller.reopen(existing.id);
        setFocusRequest(existing.id);
        return OPENED;
      }
      const shown = comparison();
      const target = shown && githubDiscussionTarget(placed, shown);
      if (
        !canAsk ||
        !parentChatId ||
        !projectPath ||
        capturing.current ||
        !target
      )
        return UNAVAILABLE;
      capturing.current = true;
      const id = crypto.randomUUID();
      const generation = getProjectScopeGeneration();
      try {
        const capture = await unwrapAnchor(
          commands.captureReviewAnchor({
            worktree: worktreePath,
            threadId: id,
            location: target.location,
            range: target.range,
            subject: {
              kind: "github_thread",
              githubThreadId: target.githubThreadId,
            },
            parent: { chatId: parentChatId, projectPath },
          })
        );
        if (!mounted.current || generation !== getProjectScopeGeneration())
          return UNAVAILABLE;
        controller.ask(
          githubDiscussionAnchor(
            target,
            capture.code.replace(/\n$/, ""),
            snapshotRef.current
          ),
          id,
          capture,
          target.githubThreadId
        );
        setFocusRequest(id);
        return OPENED;
      } catch (error) {
        // Said on the thread's card, where it was asked for.
        return generation === getProjectScopeGeneration()
          ? { opened: false, error: errorMessage(error) }
          : UNAVAILABLE;
      } finally {
        capturing.current = false;
      }
    },
    [canAsk, comparison, controller, parentChatId, projectPath, worktreePath]
  );

  // Only whether the chat takes GitHub threads matters here: its callback
  // is a new function each render and is read through `callbacks`.
  const canAttachGithub = !!onAttachGithub;
  const actions = useMemo<DiscussionActions>(() => {
    const attachThread = (id: string, question: string) => {
      const thread = controller.thread(id);
      if (!thread || thread.status.kind === "unreadable") return;
      if (thread.githubThreadId === null) {
        callbacks.current.onAttach(thread.anchor, isOutdated(thread), question);
        return;
      }
      const session = thread.sessionId
        ? useChatStore.getState().sessions[thread.sessionId]
        : undefined;
      callbacks.current.onAttachGithub?.(
        githubThreadAttachment(
          thread.githubThreadId,
          githubThread(thread.githubThreadId),
          discussionPlace(thread),
          { id: thread.id, messages: session?.messages ?? [] },
          `github-thread-${thread.githubThreadId}`
        )
      );
    };
    return {
      canAsk,
      canAskFullFile,
      select: (anchor) => {
        controller.select(anchor);
        if (anchor) void checkAvailability();
      },
      discuss: begin,
      discussGithub,
      attach: (...args) => callbacks.current.onAttach(...args),
      attachThread,
      canAttachGithub,
      attachGithub: (placed) => {
        const existing = controller.forGithubThread(placed.thread.id);
        if (existing && existing.status.kind !== "unreadable") {
          attachThread(existing.id, "");
          return;
        }
        callbacks.current.onAttachGithub?.(
          githubThreadAttachment(
            placed.thread.id,
            placed.thread,
            githubThreadPlace(
              placed,
              comparison() ?? null,
              snapshotRef.current
            ),
            null,
            `github-thread-${placed.thread.id}`
          )
        );
      },
      reopen: (id, options) => {
        const thread = id ? controller.thread(id) : undefined;
        // Shown with its GitHub thread, wherever Changes draws that.
        if (id && thread?.githubThreadId && !options?.inPlace)
          controller.reveal(id);
        else controller.reopen(id);
        setFocusRequest(id && options?.focus ? id : null);

        if (
          !options?.inPlace &&
          thread &&
          (thread.githubThreadId !== null || anchorsInChanges(thread.anchor))
        )
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
      revealed: (nonce) => controller.revealed(nonce),
      draft: (id) => controller.draft(id),
      setDraft: (id, text) => controller.setDraft(id, text),
    };
  }, [
    controller,
    send,
    cancel,
    canAsk,
    canAskFullFile,
    begin,
    discussGithub,
    githubThread,
    comparison,
    canAttachGithub,
    reconcile,
    checkAvailability,
  ]);

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
