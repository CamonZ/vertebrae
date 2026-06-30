import { create } from "zustand";
import { popOut } from "../utils/popOut";
import {
  discardStashedChatSession,
  stashChatSession,
} from "../utils/chatStash";
import {
  clearLastUsedLocalChatModelId,
  clearLocalChatSessionCleared,
  compareLocalChatSessionRecency,
  DEFAULT_LOCAL_CHAT_HARNESS,
  findPersistedLocalChatSession,
  isDisposableClosedLocalChatSession,
  isLocalChatSessionCleared,
  listPersistedLocalChatSessions,
  loadPersistedLocalChatSession,
  markLocalChatSessionCleared,
  persistLastUsedLocalChatModelId,
  persistLocalChatSession,
  projectPathMatches,
} from "../utils/localChatPersistence";
import type { LocalChatSessionSummary } from "../utils/localChatPersistence";
import type { LocalChatHarnessKind, PermissionMode } from "../bindings";

/**
 * Message types for the Claude chat
 */
export type ChatMessage =
  | { kind: "user"; text: string; timestamp: string }
  | {
      kind: "assistant";
      text: string;
      timestamp: string;
      isPartial?: boolean;
      parentToolUseId?: string;
    }
  | {
      kind: "tool_call";
      toolName: string;
      toolId: string;
      input: string;
      timestamp: string;
      /**
       * `tool_use` id of the spawning Task/Agent tool call when this call was
       * made by a sub-agent; absent for main-thread calls. Drives sub-agent
       * nesting in the rendered thread (see chatMessagesToThread).
       */
      parentToolUseId?: string;
    }
  | {
      kind: "tool_result";
      toolId: string;
      result: string;
      isError: boolean;
      timestamp: string;
      /** Parent spawn `tool_use` id when this result belongs to a sub-agent. */
      parentToolUseId?: string;
    }
  | {
      kind: "permission_request";
      requestId?: string;
      toolName: string;
      message: string;
      input?: string;
      timestamp: string;
    }
  | { kind: "session_start"; model: string; timestamp: string }
  | { kind: "warning"; message: string; timestamp: string }
  | {
      kind: "session_end";
      durationMs: number;
      costUsd: number;
      numTurns: number;
      timestamp: string;
    }
  | { kind: "error"; message: string; timestamp: string };

export type LocalChatLifecycle =
  | "idle"
  | "starting"
  | "resuming"
  | "sending"
  | "streaming"
  | "closing"
  | "closed"
  | "error";

export interface StreamingAssistantMessage {
  text: string;
  timestamp: string;
}

export interface ChatSession {
  /** Unique session identifier */
  id: string;
  /** Human-readable label for the session tab */
  label: string;
  /** Chat messages in this session */
  messages: ChatMessage[];
  /** Session status */
  status: "open" | "closed";
  /** Local chat harness that owns the runtime session. */
  harness: LocalChatHarnessKind;
  /** Runtime backend session ID for the active local harness process. */
  backendSessionId: string | null;
  /** Provider-specific durable resume ID for this conversation. */
  providerResumeId: string | null;
  /** Project root captured when the local chat session was opened. */
  projectPath?: string | null;
  /** User-selected provider model alias for session startup overrides. */
  selectedModelId?: string | null;
  /** User-selected provider reasoning effort for session startup overrides. */
  selectedReasoningEffort?: string | null;
  /** User-selected Claude Code permission mode for local session startup. */
  permissionMode?: PermissionMode | null;
  /** Model name reported by the Claude CLI (from init or per-turn usage) */
  model?: string;
  /** Latest per-turn current request input-context utilization for the badge */
  tokenUsage?: { used: number; max: number };
  /** Whether this session is detached into a standalone pop-out window */
  isDetached?: boolean;
  /** Runtime-only local chat lifecycle state */
  lifecycle?: LocalChatLifecycle;
  /** Runtime-only error detail for the current lifecycle state */
  lifecycleError?: string | null;
  /** Ephemeral assistant text currently streaming; not durable transcript state */
  streamingAssistant?: StreamingAssistantMessage | null;
  /** Durable local metadata for session-history ordering */
  createdAt?: string;
  /** Durable local metadata for session-history ordering */
  updatedAt?: string;
  /** Durable local preview for session-history display */
  preview?: string;
}

export interface ChatPane {
  /** Stable pane identifier for maximized split-chat layout */
  id: string;
  /** Store session rendered in this pane */
  sessionId: string;
}

export interface ChatPaneLayout {
  /** Visible chat panes in the maximized chat view */
  panes: ChatPane[];
  /** Pane receiving sidebar selections and pane-level controls */
  activePaneId: string | null;
}

interface ChatStoreState {
  /** All open chat sessions, keyed by session ID */
  sessions: Record<string, ChatSession>;
  /** Currently focused session ID */
  activeSessionId: string | null;
  /** Pane-to-session bindings for maximized split chat */
  paneLayout: ChatPaneLayout;
  /** Whether the chat panel is visible */
  panelOpen: boolean;
}

interface ChatStoreActions {
  /** Open or reuse a local chat session */
  openSession: (label: string, projectPath?: string | null) => string;
  /** Close a chat session */
  closeSession: (sessionId: string) => void;
  /** Focus a chat session tab */
  focusSession: (sessionId: string) => void;
  /** Focus a maximized chat pane */
  focusPane: (paneId: string) => void;
  /** Bind a pane to a session, focusing an existing pane if already visible */
  bindPaneToSession: (paneId: string, sessionId: string) => boolean;
  /** Create a fresh local chat in a new split pane */
  startFreshSessionInNewPane: (
    label: string,
    projectPath?: string | null
  ) => string;
  /** Close a split pane without closing its underlying chat session */
  closePane: (paneId: string) => void;
  /** Collapse split panes back to a single visible pane */
  unsplitPanes: (paneId?: string) => void;
  /** List persisted local chat sessions, newest first */
  listLocalSessions: (projectPath?: string | null) => LocalChatSessionSummary[];
  /** Hydrate and focus a persisted local chat session */
  selectPersistedSession: (sessionId: string) => boolean;
  /** Start a new local chat without reusing an existing session */
  startFreshSession: (label: string, projectPath?: string | null) => string;
  /** Delete one local persisted session and any in-memory copy */
  deleteLocalSession: (sessionId: string) => void;
  /** Add a message to a session */
  addMessage: (sessionId: string, message: ChatMessage) => void;
  /** Update the last assistant message (for streaming) */
  updateLastAssistantMessage: (sessionId: string, text: string) => void;
  /** Finalize the last partial assistant message */
  finalizeLastAssistantMessage: (sessionId: string, text: string) => void;
  /** Set explicit local lifecycle state */
  setSessionLifecycle: (
    sessionId: string,
    lifecycle: LocalChatLifecycle,
    errorMessage?: string | null
  ) => void;
  /** Clear any ephemeral assistant stream overlay */
  clearStreamingAssistant: (
    sessionId: string,
    commitToMessages?: boolean
  ) => void;
  /** Set the runtime backend session ID */
  setBackendSessionId: (
    sessionId: string,
    backendSessionId: string | null
  ) => void;
  /** Set the provider-specific durable resume ID */
  setProviderResumeId: (
    sessionId: string,
    providerResumeId: string | null
  ) => void;
  /** Set the model reported by the Claude CLI for a session */
  setSessionModel: (sessionId: string, model: string) => void;
  /** Set the local chat harness for this session before it starts */
  setSessionHarness: (sessionId: string, harness: LocalChatHarnessKind) => void;
  /** Set the user-selected provider model for this session */
  setSessionSelectedModel: (sessionId: string, modelId: string | null) => void;
  /** Set the user-selected provider reasoning effort for this session */
  setSessionReasoningEffort: (
    sessionId: string,
    reasoningEffort: string | null
  ) => void;
  /** Set the user-selected Claude Code permission mode for this session */
  setSessionPermissionMode: (
    sessionId: string,
    permissionMode: PermissionMode | null
  ) => void;
  /** Set the latest per-turn current request input-context utilization */
  setSessionTokenUsage: (
    sessionId: string,
    usage: { used: number; max: number }
  ) => void;
  /** Update model and token usage together in a single render */
  setSessionUsage: (
    sessionId: string,
    model: string,
    usage: { used: number; max: number }
  ) => void;
  /** Mark a session as closed */
  markSessionClosed: (sessionId: string) => void;
  /** Clear messages in a session */
  clearMessages: (sessionId: string) => void;
  /** Toggle the chat panel open/closed */
  togglePanel: () => void;
  /** Set panel open state explicitly */
  setPanelOpen: (open: boolean) => void;
  /** Detach a session into a standalone pop-out window. */
  detachSession: (sessionId: string) => Promise<void>;
  /** Reattach a previously detached session back into the main panel. */
  reattachSession: (sessionId: string) => void;
  /** Reset local chat sessions */
  reset: () => void;
}

export type ChatStore = ChatStoreState & ChatStoreActions;

export const MAX_CHAT_PANES = 6;

const emptyPaneLayout: ChatPaneLayout = {
  panes: [],
  activePaneId: null,
};

const emptyState: ChatStoreState = {
  sessions: {},
  activeSessionId: null,
  paneLayout: emptyPaneLayout,
  panelOpen: false,
};

const initialState: ChatStoreState = {
  ...emptyState,
};

function generateSessionId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function generatePaneId(): string {
  return `pane-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function createLocalSession(
  label: string,
  projectPath?: string | null
): ChatSession {
  const now = new Date().toISOString();
  return {
    id: generateSessionId(),
    label,
    messages: [],
    status: "open",
    harness: DEFAULT_LOCAL_CHAT_HARNESS,
    backendSessionId: null,
    providerResumeId: null,
    projectPath,
    permissionMode: "default",
    lifecycle: "idle",
    lifecycleError: null,
    streamingAssistant: null,
    createdAt: now,
    updatedAt: now,
    preview: "No messages yet",
  };
}

function hydrateLocalSession(session: ChatSession): ChatSession {
  return {
    ...session,
    isDetached: false,
    harness: session.harness ?? DEFAULT_LOCAL_CHAT_HARNESS,
    backendSessionId: null,
    lifecycle: session.lifecycle ?? "idle",
    lifecycleError: null,
    streamingAssistant: null,
  };
}

export function getLocalChatLifecycle(
  session: ChatSession | null | undefined
): LocalChatLifecycle {
  if (!session) return "idle";
  if (session.lifecycle) return session.lifecycle;
  return "idle";
}

export function isLocalChatLifecycleBusy(
  lifecycle: LocalChatLifecycle
): boolean {
  return (
    lifecycle === "starting" ||
    lifecycle === "resuming" ||
    lifecycle === "sending" ||
    lifecycle === "streaming" ||
    lifecycle === "closing"
  );
}

function findMatchingSession(
  sessions: Record<string, ChatSession>,
  projectPath?: string | null
): string | null {
  return (
    Object.values(sessions)
      .filter(
        (session) =>
          session.status === "open" &&
          !session.isDetached &&
          projectPathMatches(session.projectPath, projectPath)
      )
      .sort(compareLocalChatSessionRecency)[0]?.id ?? null
  );
}

function latestSessionId(sessions: Record<string, ChatSession>): string | null {
  return (
    Object.values(sessions)
      .filter((session) => session.status === "open" && !session.isDetached)
      .sort(compareLocalChatSessionRecency)[0]?.id ?? null
  );
}

function activeSessionIdFromPaneLayout(
  paneLayout: ChatPaneLayout
): string | null {
  return (
    paneLayout.panes.find((pane) => pane.id === paneLayout.activePaneId)
      ?.sessionId ??
    paneLayout.panes[0]?.sessionId ??
    null
  );
}

export function normalizePaneLayout(
  paneLayout: ChatPaneLayout | undefined,
  sessions: Record<string, ChatSession>
): ChatPaneLayout {
  const seenSessionIds = new Set<string>();
  const panes = (paneLayout?.panes ?? []).filter((pane) => {
    const session = sessions[pane.sessionId];
    if (!session || session.status !== "open" || session.isDetached) {
      return false;
    }
    if (seenSessionIds.has(pane.sessionId)) return false;
    seenSessionIds.add(pane.sessionId);
    return true;
  });
  const activePaneId =
    paneLayout?.activePaneId &&
    panes.some((pane) => pane.id === paneLayout.activePaneId)
      ? paneLayout.activePaneId
      : (panes[0]?.id ?? null);

  return { panes, activePaneId };
}

function focusSessionInPaneLayout(
  state: Pick<ChatStoreState, "sessions" | "activeSessionId" | "paneLayout">,
  sessionId: string
): Pick<ChatStoreState, "activeSessionId" | "paneLayout"> {
  const session = state.sessions[sessionId];
  if (!session || session.status !== "open" || session.isDetached) {
    return {
      activeSessionId: state.activeSessionId,
      paneLayout: normalizePaneLayout(state.paneLayout, state.sessions),
    };
  }

  const paneLayout = normalizePaneLayout(state.paneLayout, state.sessions);
  const existingPane = paneLayout.panes.find(
    (pane) => pane.sessionId === sessionId
  );
  if (existingPane) {
    return {
      activeSessionId: sessionId,
      paneLayout: {
        panes: paneLayout.panes,
        activePaneId: existingPane.id,
      },
    };
  }

  const activePaneId = paneLayout.activePaneId ?? paneLayout.panes[0]?.id;
  if (activePaneId) {
    return {
      activeSessionId: sessionId,
      paneLayout: {
        panes: paneLayout.panes.map((pane) =>
          pane.id === activePaneId ? { ...pane, sessionId } : pane
        ),
        activePaneId,
      },
    };
  }

  const pane = { id: generatePaneId(), sessionId };
  return {
    activeSessionId: sessionId,
    paneLayout: {
      panes: [pane],
      activePaneId: pane.id,
    },
  };
}

function addSessionPane(
  state: Pick<ChatStoreState, "sessions" | "activeSessionId" | "paneLayout">,
  sessionId: string
): Pick<ChatStoreState, "activeSessionId" | "paneLayout"> {
  const session = state.sessions[sessionId];
  if (!session || session.status !== "open" || session.isDetached) {
    return {
      activeSessionId: state.activeSessionId,
      paneLayout: normalizePaneLayout(state.paneLayout, state.sessions),
    };
  }

  const paneLayout = normalizePaneLayout(state.paneLayout, state.sessions);
  const existingPane = paneLayout.panes.find(
    (pane) => pane.sessionId === sessionId
  );
  if (existingPane) {
    return {
      activeSessionId: sessionId,
      paneLayout: {
        panes: paneLayout.panes,
        activePaneId: existingPane.id,
      },
    };
  }

  if (paneLayout.panes.length >= MAX_CHAT_PANES) {
    return focusSessionInPaneLayout(state, sessionId);
  }

  const pane = { id: generatePaneId(), sessionId };
  return {
    activeSessionId: sessionId,
    paneLayout: {
      panes: [...paneLayout.panes, pane],
      activePaneId: pane.id,
    },
  };
}

function removePaneFromLayout(
  state: Pick<ChatStoreState, "sessions" | "activeSessionId" | "paneLayout">,
  paneId: string
): Pick<ChatStoreState, "activeSessionId" | "paneLayout"> {
  const paneLayout = normalizePaneLayout(state.paneLayout, state.sessions);
  if (paneLayout.panes.length <= 1) {
    return {
      activeSessionId: activeSessionIdFromPaneLayout(paneLayout),
      paneLayout,
    };
  }

  const panes = paneLayout.panes.filter((pane) => pane.id !== paneId);
  if (panes.length === paneLayout.panes.length) {
    return {
      activeSessionId: activeSessionIdFromPaneLayout(paneLayout),
      paneLayout,
    };
  }

  const activePaneId =
    paneLayout.activePaneId === paneId
      ? (panes[0]?.id ?? null)
      : paneLayout.activePaneId;
  const nextLayout = { panes, activePaneId };
  return {
    activeSessionId: activeSessionIdFromPaneLayout(nextLayout),
    paneLayout: nextLayout,
  };
}

function removeSessionFromRuntimeState(
  state: ChatStoreState,
  sessionId: string
): Pick<
  ChatStoreState,
  "sessions" | "activeSessionId" | "paneLayout" | "panelOpen"
> {
  const remaining = Object.fromEntries(
    Object.entries(state.sessions).filter(([id]) => id !== sessionId)
  );
  const normalizedPaneLayout = normalizePaneLayout(state.paneLayout, remaining);
  const activePaneSessionId =
    activeSessionIdFromPaneLayout(normalizedPaneLayout);
  const activeSessionStillOpen =
    state.activeSessionId !== null && !!remaining[state.activeSessionId];
  const sessionIds = Object.keys(remaining);

  return {
    sessions: remaining,
    activeSessionId: activeSessionStillOpen
      ? state.activeSessionId
      : (activePaneSessionId ?? latestSessionId(remaining)),
    paneLayout: normalizedPaneLayout,
    panelOpen: sessionIds.length > 0 ? state.panelOpen : false,
  };
}

function collapsePaneLayout(
  state: Pick<ChatStoreState, "sessions" | "activeSessionId" | "paneLayout">,
  paneId?: string
): Pick<ChatStoreState, "activeSessionId" | "paneLayout"> {
  const paneLayout = normalizePaneLayout(state.paneLayout, state.sessions);
  const keepPane =
    (paneId && paneLayout.panes.find((pane) => pane.id === paneId)) ||
    paneLayout.panes.find((pane) => pane.id === paneLayout.activePaneId) ||
    (state.activeSessionId
      ? paneLayout.panes.find(
          (pane) => pane.sessionId === state.activeSessionId
        )
      : undefined) ||
    paneLayout.panes[0];

  if (!keepPane) {
    return { activeSessionId: null, paneLayout: emptyPaneLayout };
  }

  return {
    activeSessionId: keepPane.sessionId,
    paneLayout: {
      panes: [keepPane],
      activePaneId: keepPane.id,
    },
  };
}

export const useChatStore = create<ChatStore>((set, get) => {
  const updateSession = (
    sessionId: string,
    updater: (session: ChatSession) => ChatSession,
    options: { persist?: boolean } = {}
  ) => {
    let updated: ChatSession | null = null;
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      const next = updater(session);
      if (next === session) return state;
      updated = next;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: next,
        },
      };
    });
    if (updated && options.persist !== false) {
      persistLocalChatSession(updated);
    }
  };

  return {
    ...initialState,

    // Actions
    openSession: (label, projectPath) => {
      const existing = findMatchingSession(get().sessions, projectPath);
      if (existing) {
        set((state) => ({
          ...focusSessionInPaneLayout(state, existing),
          panelOpen: true,
        }));
        return existing;
      }

      const persisted = findPersistedLocalChatSession(projectPath);
      if (persisted) {
        const hydrated: ChatSession = hydrateLocalSession({
          ...persisted,
          projectPath: persisted.projectPath ?? projectPath,
        });
        set((state) => {
          const nextSessions = { ...state.sessions, [hydrated.id]: hydrated };
          return {
            sessions: nextSessions,
            ...focusSessionInPaneLayout(
              {
                ...state,
                sessions: nextSessions,
              },
              hydrated.id
            ),
            panelOpen: true,
          };
        });
        return hydrated.id;
      }

      const session = createLocalSession(label, projectPath);
      const id = session.id;

      persistLocalChatSession(session);

      set((state) => {
        const nextSessions = { ...state.sessions, [id]: session };
        return {
          sessions: nextSessions,
          ...focusSessionInPaneLayout({ ...state, sessions: nextSessions }, id),
          panelOpen: true,
        };
      });

      return id;
    },

    closeSession: (sessionId) => {
      set((state) => {
        if (!state.sessions[sessionId]) return state;
        return removeSessionFromRuntimeState(state, sessionId);
      });
    },

    focusSession: (sessionId) => {
      set((state) => focusSessionInPaneLayout(state, sessionId));
    },

    focusPane: (paneId) => {
      set((state) => {
        const paneLayout = normalizePaneLayout(
          state.paneLayout,
          state.sessions
        );
        const pane = paneLayout.panes.find((item) => item.id === paneId);
        if (!pane) return { paneLayout };
        return {
          activeSessionId: pane.sessionId,
          paneLayout: {
            panes: paneLayout.panes,
            activePaneId: pane.id,
          },
        };
      });
    },

    bindPaneToSession: (paneId, sessionId) => {
      let bound = false;
      set((state) => {
        const session = state.sessions[sessionId];
        if (!session || session.status !== "open" || session.isDetached) {
          return {
            paneLayout: normalizePaneLayout(state.paneLayout, state.sessions),
          };
        }
        const paneLayout = normalizePaneLayout(
          state.paneLayout,
          state.sessions
        );
        const existingPane = paneLayout.panes.find(
          (pane) => pane.sessionId === sessionId
        );
        if (existingPane) {
          bound = true;
          return {
            activeSessionId: sessionId,
            paneLayout: {
              panes: paneLayout.panes,
              activePaneId: existingPane.id,
            },
          };
        }
        if (!paneLayout.panes.some((pane) => pane.id === paneId)) {
          return { paneLayout };
        }
        bound = true;
        return {
          activeSessionId: sessionId,
          paneLayout: {
            panes: paneLayout.panes.map((pane) =>
              pane.id === paneId ? { ...pane, sessionId } : pane
            ),
            activePaneId: paneId,
          },
        };
      });
      return bound;
    },

    startFreshSessionInNewPane: (label, projectPath) => {
      const session = createLocalSession(label, projectPath);
      persistLocalChatSession(session);
      set((state) => {
        const nextSessions = { ...state.sessions, [session.id]: session };
        return {
          sessions: nextSessions,
          ...addSessionPane({ ...state, sessions: nextSessions }, session.id),
          panelOpen: true,
        };
      });
      return session.id;
    },

    closePane: (paneId) => {
      set((state) => removePaneFromLayout(state, paneId));
    },

    unsplitPanes: (paneId) => {
      set((state) => collapsePaneLayout(state, paneId));
    },

    listLocalSessions: (projectPath) => {
      return listPersistedLocalChatSessions(projectPath);
    },

    selectPersistedSession: (sessionId) => {
      const existing = get().sessions[sessionId];
      if (existing) {
        let reattached: ChatSession | null = null;
        set((state) => {
          const current = state.sessions[sessionId];
          if (!current) return state;
          const nextSession = current.isDetached
            ? { ...current, isDetached: false }
            : current;
          const nextSessions = current.isDetached
            ? { ...state.sessions, [sessionId]: nextSession }
            : state.sessions;
          if (current.isDetached) {
            reattached = nextSession;
          }
          return {
            sessions: nextSessions,
            ...focusSessionInPaneLayout(
              { ...state, sessions: nextSessions },
              sessionId
            ),
            panelOpen: true,
          };
        });
        if (reattached) {
          persistLocalChatSession(reattached);
        }
        return true;
      }

      const persisted = loadPersistedLocalChatSession(sessionId);
      if (!persisted || persisted.status !== "open") return false;
      const hydrated = hydrateLocalSession(persisted);
      set((state) => {
        const nextSessions = { ...state.sessions, [hydrated.id]: hydrated };
        return {
          sessions: nextSessions,
          ...focusSessionInPaneLayout(
            {
              ...state,
              sessions: nextSessions,
            },
            hydrated.id
          ),
          panelOpen: true,
        };
      });
      return true;
    },

    startFreshSession: (label, projectPath) => {
      const session = createLocalSession(label, projectPath);
      persistLocalChatSession(session);
      set((state) => {
        const nextSessions = { ...state.sessions, [session.id]: session };
        return {
          sessions: nextSessions,
          ...focusSessionInPaneLayout(
            {
              ...state,
              sessions: nextSessions,
            },
            session.id
          ),
          panelOpen: true,
        };
      });
      return session.id;
    },

    deleteLocalSession: (sessionId) => {
      markLocalChatSessionCleared(sessionId);
      discardStashedChatSession(sessionId);
      set((state) => {
        if (!state.sessions[sessionId]) return state;
        return removeSessionFromRuntimeState(state, sessionId);
      });
    },

    addMessage: (sessionId, message) => {
      updateSession(sessionId, (session) => {
        const messages = [...session.messages];
        const last = messages[messages.length - 1];
        if (
          message.kind === "assistant" &&
          message.parentToolUseId &&
          last?.kind === "assistant" &&
          last.parentToolUseId === message.parentToolUseId &&
          last.isPartial
        ) {
          messages[messages.length - 1] = {
            ...last,
            text: message.isPartial
              ? `${last.text}${message.text}`
              : message.text,
            isPartial: message.isPartial,
            timestamp: message.timestamp,
          };
        } else {
          messages.push(message);
        }
        return {
          ...session,
          messages,
          updatedAt: message.timestamp,
        };
      });
    },

    updateLastAssistantMessage: (sessionId, text) => {
      updateSession(
        sessionId,
        (session) => {
          if (!text) return session;
          const current = session.streamingAssistant;
          return {
            ...session,
            lifecycle: "streaming",
            lifecycleError: null,
            streamingAssistant: {
              text: `${current?.text ?? ""}${text}`,
              timestamp: current?.timestamp ?? new Date().toISOString(),
            },
          };
        },
        { persist: false }
      );
    },

    finalizeLastAssistantMessage: (sessionId, text) => {
      updateSession(sessionId, (session) => {
        const messages = [...session.messages];
        const timestamp = new Date().toISOString();
        const last = messages[messages.length - 1];
        if (last?.kind === "assistant" && last.isPartial) {
          messages[messages.length - 1] = {
            ...last,
            text,
            isPartial: false,
          };
        } else {
          messages.push({
            kind: "assistant",
            text,
            timestamp,
            isPartial: false,
          });
        }
        return {
          ...session,
          messages,
          updatedAt: timestamp,
          lifecycle: "idle",
          lifecycleError: null,
          streamingAssistant: null,
        };
      });
    },

    setSessionLifecycle: (sessionId, lifecycle, errorMessage = null) => {
      updateSession(
        sessionId,
        (session) => {
          const normalizedError =
            lifecycle === "error"
              ? (errorMessage ?? "Claude session failed")
              : null;
          if (
            getLocalChatLifecycle(session) === lifecycle &&
            (session.lifecycleError ?? null) === normalizedError
          ) {
            return session;
          }
          return {
            ...session,
            lifecycle,
            lifecycleError: normalizedError,
          };
        },
        { persist: false }
      );
    },

    clearStreamingAssistant: (sessionId, commitToMessages = false) => {
      updateSession(
        sessionId,
        (session) => {
          const streaming = session.streamingAssistant;
          if (!streaming) return session;
          const timestamp =
            commitToMessages && streaming.text
              ? new Date().toISOString()
              : streaming.timestamp;
          const messages =
            commitToMessages && streaming.text
              ? [
                  ...session.messages,
                  {
                    kind: "assistant" as const,
                    text: streaming.text,
                    timestamp,
                    isPartial: false,
                  },
                ]
              : session.messages;
          return {
            ...session,
            messages,
            updatedAt:
              commitToMessages && streaming.text
                ? timestamp
                : session.updatedAt,
            streamingAssistant: null,
          };
        },
        { persist: commitToMessages }
      );
    },

    setBackendSessionId: (sessionId, backendSessionId) => {
      updateSession(
        sessionId,
        (session) => ({ ...session, backendSessionId }),
        {
          persist: false,
        }
      );
    },

    setProviderResumeId: (sessionId, providerResumeId) => {
      updateSession(sessionId, (session) => ({
        ...session,
        providerResumeId,
      }));
    },

    setSessionModel: (sessionId, model) => {
      updateSession(sessionId, (session) =>
        session.model === model ? session : { ...session, model }
      );
    },

    setSessionHarness: (sessionId, harness) => {
      updateSession(sessionId, (session) => {
        if (session.backendSessionId || session.providerResumeId) {
          return session;
        }
        if (session.harness === harness) return session;
        return {
          ...session,
          harness,
          selectedModelId: undefined,
          selectedReasoningEffort: undefined,
          model: undefined,
          tokenUsage: undefined,
        };
      });
      clearLastUsedLocalChatModelId();
    },

    setSessionSelectedModel: (sessionId, modelId) => {
      const normalized = modelId?.trim() || null;
      updateSession(sessionId, (session) =>
        session.selectedModelId === normalized
          ? session
          : { ...session, selectedModelId: normalized }
      );
      if (normalized) {
        persistLastUsedLocalChatModelId(normalized);
      } else {
        clearLastUsedLocalChatModelId();
      }
    },

    setSessionReasoningEffort: (sessionId, reasoningEffort) => {
      const normalized = reasoningEffort?.trim() || null;
      updateSession(sessionId, (session) =>
        session.selectedReasoningEffort === normalized
          ? session
          : { ...session, selectedReasoningEffort: normalized }
      );
    },

    setSessionPermissionMode: (sessionId, permissionMode) => {
      updateSession(sessionId, (session) =>
        session.permissionMode === permissionMode
          ? session
          : { ...session, permissionMode }
      );
    },

    setSessionTokenUsage: (sessionId, usage) => {
      updateSession(sessionId, (session) => {
        if (
          session.tokenUsage?.used === usage.used &&
          session.tokenUsage?.max === usage.max
        ) {
          return session;
        }
        return { ...session, tokenUsage: usage };
      });
    },

    setSessionUsage: (sessionId, model, usage) => {
      updateSession(sessionId, (session) => {
        if (
          session.model === model &&
          session.tokenUsage?.used === usage.used &&
          session.tokenUsage?.max === usage.max
        ) {
          return session;
        }
        return { ...session, model, tokenUsage: usage };
      });
    },

    markSessionClosed: (sessionId) => {
      const session = get().sessions[sessionId];
      if (!session) return;
      const closedSession = {
        ...session,
        status: "open" as const,
        backendSessionId: null,
        lifecycle: "closed" as const,
        lifecycleError: null,
        streamingAssistant: null,
      };
      if (isDisposableClosedLocalChatSession(closedSession)) {
        persistLocalChatSession(closedSession);
        set((state) => {
          if (!state.sessions[sessionId]) return state;
          return removeSessionFromRuntimeState(state, sessionId);
        });
        return;
      }
      updateSession(sessionId, () => closedSession);
    },

    clearMessages: (sessionId) => {
      if (!get().sessions[sessionId]) return;
      markLocalChatSessionCleared(sessionId);
      discardStashedChatSession(sessionId);
      const timestamp = new Date().toISOString();
      set((state) => {
        const session = state.sessions[sessionId];
        if (!session) return state;
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: {
              ...session,
              messages: [],
              backendSessionId: null,
              providerResumeId: null,
              selectedModelId: session.selectedModelId ?? null,
              model: undefined,
              tokenUsage: undefined,
              status: "open",
              lifecycle: "idle",
              lifecycleError: null,
              streamingAssistant: null,
              updatedAt: timestamp,
              preview: "No messages yet",
            },
          },
        };
      });
    },

    togglePanel: () => {
      set((state) => ({ panelOpen: !state.panelOpen }));
    },

    setPanelOpen: (open) => {
      set({ panelOpen: open });
    },

    detachSession: async (sessionId) => {
      const session = get().sessions[sessionId];
      if (!session || session.isDetached) return;

      // Stash the full session so the pop-out can seed its empty store
      // synchronously before first paint. The existing backendSessionId is
      // carried across so useLocalChat does not double-create the backend
      // local chat session.
      stashChatSession({ ...session, isDetached: true });

      const updated = { ...session, isDetached: true };
      persistLocalChatSession(updated);

      set((state) => {
        if (!state.sessions[sessionId]) return state;
        const remainingIds = Object.keys(state.sessions).filter(
          (id) => id !== sessionId && !state.sessions[id].isDetached
        );
        const nextActiveSessionId =
          state.activeSessionId === sessionId
            ? (remainingIds[remainingIds.length - 1] ?? null)
            : state.activeSessionId;
        const nextSessions = {
          ...state.sessions,
          [sessionId]: updated,
        };
        const nextPaneLayout = normalizePaneLayout(
          state.paneLayout,
          nextSessions
        );
        return {
          sessions: nextSessions,
          activeSessionId: nextActiveSessionId,
          paneLayout: nextPaneLayout,
        };
      });

      const { window: webview, reused } = await popOut(
        `/chat?sessionId=${encodeURIComponent(sessionId)}`,
        `chat-${sessionId}`,
        {
          title: session.label,
          width: 600,
          height: 800,
        }
      );

      // Listen once for the pop-out window's close so we reattach the session
      // back into the main panel. `reused` means a prior detach already
      // installed the listener — don't stack another.
      if (!reused) {
        try {
          await webview.onCloseRequested(() => {
            get().reattachSession(sessionId);
          });
        } catch {
          // Listener registration can fail in tests / non-Tauri contexts;
          // reattach will simply not fire automatically there.
        }
      }
    },

    reattachSession: (sessionId) => {
      const wasCleared = isLocalChatSessionCleared(sessionId);
      let updated: ChatSession | null = null;
      set((state) => {
        const session = state.sessions[sessionId];
        if (!session) return state;
        if (wasCleared) {
          const remaining = Object.fromEntries(
            Object.entries(state.sessions).filter(([id]) => id !== sessionId)
          );
          const sessionIds = Object.keys(remaining);
          const normalizedPaneLayout = normalizePaneLayout(
            state.paneLayout,
            remaining
          );
          const activePaneSessionId =
            activeSessionIdFromPaneLayout(normalizedPaneLayout);
          return {
            sessions: remaining,
            activeSessionId:
              state.activeSessionId === sessionId
                ? (activePaneSessionId ??
                  sessionIds[sessionIds.length - 1] ??
                  null)
                : state.activeSessionId,
            paneLayout: normalizedPaneLayout,
            panelOpen: sessionIds.length > 0 ? state.panelOpen : false,
          };
        }
        updated = { ...session, isDetached: false };
        const nextSessions = {
          ...state.sessions,
          [sessionId]: updated,
        };
        const nextState = {
          ...state,
          sessions: nextSessions,
        };
        return {
          sessions: nextSessions,
          ...addSessionPane(nextState, sessionId),
          panelOpen: true,
        };
      });
      if (wasCleared) {
        clearLocalChatSessionCleared(sessionId);
      } else if (updated) {
        persistLocalChatSession(updated);
      }
    },

    reset: () => set(emptyState),
  };
});
