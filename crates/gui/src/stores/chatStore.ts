import { create } from "zustand";
import { popOut } from "../utils/popOut";
import {
  discardStashedChatSession,
  stashChatSession,
} from "../utils/chatStash";
import { scopeLabel } from "../utils/chatContext";
import {
  clearLastUsedLocalChatModelId,
  clearLocalChatSessionCleared,
  findPersistedLocalChatSession,
  isLocalChatSessionCleared,
  listPersistedLocalChatSessions,
  loadPersistedLocalChatSessions,
  loadPersistedLocalChatSession,
  markLocalChatSessionCleared,
  persistLastUsedLocalChatModelId,
  persistLocalChatSession,
  projectPathMatches,
} from "../utils/localChatPersistence";
import type { LocalChatSessionSummary } from "../utils/localChatPersistence";
import type { PermissionMode } from "../bindings";

/**
 * Message types for the Claude chat
 */
export type ChatMessage =
  | { kind: "user"; text: string; timestamp: string }
  | { kind: "assistant"; text: string; timestamp: string; isPartial?: boolean }
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

/**
 * Scope levels for chat sessions.
 * Each session is scoped to a particular entity type.
 */
export type ChatScope = "project" | "workflow" | "task" | "step";

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

/**
 * Scope hierarchy for widening. Each scope can widen to the next level up.
 */
const SCOPE_HIERARCHY: Record<ChatScope, ChatScope | null> = {
  step: "task",
  task: "workflow",
  workflow: "project",
  project: null,
};

/**
 * A chat session scoped to a particular entity.
 */
export interface ChatSession {
  /** Unique session identifier */
  id: string;
  /** The scope level of this chat */
  scope: ChatScope;
  /** The entity ID this chat is scoped to (null for project scope) */
  entityId: string | null;
  /** Human-readable label for the session tab */
  label: string;
  /** Chat messages in this session */
  messages: ChatMessage[];
  /** Session status */
  status: "open" | "closed";
  /** The Claude CLI session ID (for the backend) */
  claudeSessionId: string | null;
  /** Claude conversation ID for resume support */
  claudeConversationId: string | null;
  /** Injected context summary (read-only snapshot) */
  contextSummary: string | null;
  /** Project root captured when the local chat session was opened. */
  projectPath?: string | null;
  /** User-selected Claude Code model alias for session startup/resume overrides. */
  selectedModelId?: string | null;
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

interface ChatStoreState {
  /** All open chat sessions, keyed by session ID */
  sessions: Record<string, ChatSession>;
  /** Currently focused session ID */
  activeSessionId: string | null;
  /** Whether the chat panel is visible */
  panelOpen: boolean;
}

interface ChatStoreActions {
  /** Open a new chat session for the given scope */
  openSession: (
    scope: ChatScope,
    entityId: string | null,
    label: string,
    projectPath?: string | null
  ) => string;
  /** Close a chat session */
  closeSession: (sessionId: string) => void;
  /** Focus a chat session tab */
  focusSession: (sessionId: string) => void;
  /** List persisted local chat sessions, newest first */
  listLocalSessions: (projectPath?: string | null) => LocalChatSessionSummary[];
  /** Hydrate and focus a persisted local chat session */
  selectPersistedSession: (sessionId: string) => boolean;
  /** Start a new local chat without reusing an existing scope/entity session */
  startFreshSession: (
    scope: ChatScope,
    entityId: string | null,
    label: string,
    projectPath?: string | null
  ) => string;
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
  /** Set the Claude backend session ID */
  setClaudeSessionId: (
    sessionId: string,
    claudeSessionId: string | null
  ) => void;
  /** Set the Claude conversation ID for resume */
  setClaudeConversationId: (
    sessionId: string,
    conversationId: string | null
  ) => void;
  /** Set context summary for a session */
  setContextSummary: (sessionId: string, summary: string) => void;
  /** Set the model reported by the Claude CLI for a session */
  setSessionModel: (sessionId: string, model: string) => void;
  /** Set the user-selected Claude Code model for this session */
  setSessionSelectedModel: (sessionId: string, modelId: string | null) => void;
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
  /** Widen the scope of a session (step -> task -> workflow -> project) */
  widenScope: (
    sessionId: string,
    newScope: ChatScope,
    newEntityId: string | null,
    newLabel: string
  ) => void;
  /** Find an existing open session for a scope+entity */
  findSession: (scope: ChatScope, entityId: string | null) => string | null;
  /** Detach a session into a standalone pop-out window. */
  detachSession: (sessionId: string) => Promise<void>;
  /** Reattach a previously detached session back into the main panel. */
  reattachSession: (sessionId: string) => void;
  /** Reset project-scoped chat sessions */
  reset: () => void;
}

export type ChatStore = ChatStoreState & ChatStoreActions;

const emptyState: ChatStoreState = {
  sessions: {},
  activeSessionId: null,
  panelOpen: false,
};

const initialState: ChatStoreState = {
  ...emptyState,
  sessions: loadPersistedLocalChatSessions(),
};

function generateSessionId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

function createLocalSession(
  scope: ChatScope,
  entityId: string | null,
  label: string,
  projectPath?: string | null
): ChatSession {
  const now = new Date().toISOString();
  return {
    id: generateSessionId(),
    scope,
    entityId,
    label,
    messages: [],
    status: "open",
    claudeSessionId: null,
    claudeConversationId: null,
    contextSummary: null,
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
    claudeSessionId: null,
    lifecycle: session.lifecycle ?? "idle",
    lifecycleError: null,
    streamingAssistant: null,
  };
}

/**
 * Get the parent scope for widening.
 */
export function getParentScope(scope: ChatScope): ChatScope | null {
  return SCOPE_HIERARCHY[scope];
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
  scope: ChatScope,
  entityId: string | null,
  projectPath?: string | null
): string | null {
  for (const [id, session] of Object.entries(sessions)) {
    if (session.status !== "open") continue;
    if (session.scope !== scope || session.entityId !== entityId) continue;
    if (!projectPathMatches(session.projectPath, projectPath)) {
      continue;
    }
    return id;
  }
  return null;
}

function latestSessionId(sessions: Record<string, ChatSession>): string | null {
  return (
    Object.values(sessions)
      .filter((session) => session.status === "open" && !session.isDetached)
      .sort((a, b) => {
        const aTime = Date.parse(a.updatedAt ?? a.createdAt ?? "");
        const bTime = Date.parse(b.updatedAt ?? b.createdAt ?? "");
        return (
          (Number.isNaN(bTime) ? 0 : bTime) - (Number.isNaN(aTime) ? 0 : aTime)
        );
      })[0]?.id ?? null
  );
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
    openSession: (scope, entityId, label, projectPath) => {
      // Check if a session already exists for this scope+entity
      const existing = findMatchingSession(
        get().sessions,
        scope,
        entityId,
        projectPath
      );
      if (existing) {
        set({ activeSessionId: existing, panelOpen: true });
        return existing;
      }

      const persisted = findPersistedLocalChatSession(
        scope,
        entityId,
        projectPath
      );
      if (persisted) {
        const hydrated: ChatSession = hydrateLocalSession({
          ...persisted,
          projectPath: persisted.projectPath ?? projectPath,
        });
        set((state) => ({
          sessions: { ...state.sessions, [hydrated.id]: hydrated },
          activeSessionId: hydrated.id,
          panelOpen: true,
        }));
        return hydrated.id;
      }

      const session = createLocalSession(scope, entityId, label, projectPath);
      const id = session.id;

      persistLocalChatSession(session);

      set((state) => ({
        sessions: { ...state.sessions, [id]: session },
        activeSessionId: id,
        panelOpen: true,
      }));

      return id;
    },

    closeSession: (sessionId) => {
      set((state) => {
        const remaining = Object.fromEntries(
          Object.entries(state.sessions).filter(([id]) => id !== sessionId)
        );
        const newActiveId =
          state.activeSessionId === sessionId
            ? latestSessionId(remaining)
            : state.activeSessionId;
        const sessionIds = Object.keys(remaining);

        return {
          sessions: remaining,
          activeSessionId: newActiveId,
          panelOpen: sessionIds.length > 0 ? state.panelOpen : false,
        };
      });
    },

    focusSession: (sessionId) => {
      set({ activeSessionId: sessionId });
    },

    listLocalSessions: (projectPath) => {
      return listPersistedLocalChatSessions(projectPath);
    },

    selectPersistedSession: (sessionId) => {
      const existing = get().sessions[sessionId];
      if (existing) {
        set({
          activeSessionId: sessionId,
          panelOpen: true,
        });
        return true;
      }

      const persisted = loadPersistedLocalChatSession(sessionId);
      if (!persisted || persisted.status !== "open") return false;
      const hydrated = hydrateLocalSession(persisted);
      set((state) => ({
        sessions: { ...state.sessions, [hydrated.id]: hydrated },
        activeSessionId: hydrated.id,
        panelOpen: true,
      }));
      return true;
    },

    startFreshSession: (scope, entityId, label, projectPath) => {
      const session = createLocalSession(scope, entityId, label, projectPath);
      persistLocalChatSession(session);
      set((state) => ({
        sessions: { ...state.sessions, [session.id]: session },
        activeSessionId: session.id,
        panelOpen: true,
      }));
      return session.id;
    },

    deleteLocalSession: (sessionId) => {
      markLocalChatSessionCleared(sessionId);
      discardStashedChatSession(sessionId);
      set((state) => {
        if (!state.sessions[sessionId]) return state;
        const remaining = Object.fromEntries(
          Object.entries(state.sessions).filter(([id]) => id !== sessionId)
        );
        const sessionIds = Object.keys(remaining);
        return {
          sessions: remaining,
          activeSessionId:
            state.activeSessionId === sessionId
              ? latestSessionId(remaining)
              : state.activeSessionId,
          panelOpen: sessionIds.length > 0 ? state.panelOpen : false,
        };
      });
    },

    addMessage: (sessionId, message) => {
      updateSession(sessionId, (session) => ({
        ...session,
        messages: [...session.messages, message],
        updatedAt: message.timestamp,
      }));
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

    setClaudeSessionId: (sessionId, claudeSessionId) => {
      updateSession(sessionId, (session) => ({ ...session, claudeSessionId }), {
        persist: false,
      });
    },

    setClaudeConversationId: (sessionId, conversationId) => {
      updateSession(sessionId, (session) => ({
        ...session,
        claudeConversationId: conversationId,
      }));
    },

    setContextSummary: (sessionId, summary) => {
      updateSession(sessionId, (session) => ({
        ...session,
        contextSummary: summary,
      }));
    },

    setSessionModel: (sessionId, model) => {
      updateSession(sessionId, (session) =>
        session.model === model ? session : { ...session, model }
      );
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
      if (!get().sessions[sessionId]) return;
      updateSession(sessionId, (session) => ({
        ...session,
        status: "open" as const,
        claudeSessionId: null,
        lifecycle: "closed",
        lifecycleError: null,
        streamingAssistant: null,
      }));
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
              claudeSessionId: null,
              claudeConversationId: null,
              contextSummary: null,
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

    widenScope: (sessionId, newScope, newEntityId, newLabel) => {
      updateSession(sessionId, (session) => ({
        ...session,
        scope: newScope,
        entityId: newEntityId,
        label: newLabel,
      }));
    },

    detachSession: async (sessionId) => {
      const session = get().sessions[sessionId];
      if (!session || session.isDetached) return;

      // Stash the full session so the pop-out can seed its empty store
      // synchronously before first paint. The existing claudeSessionId is
      // carried across so useScopedChat does not double-create the backend
      // Claude session.
      stashChatSession({ ...session, isDetached: true });

      const updated = { ...session, isDetached: true };
      persistLocalChatSession(updated);

      set((state) => {
        if (!state.sessions[sessionId]) return state;
        const remainingIds = Object.keys(state.sessions).filter(
          (id) => id !== sessionId && !state.sessions[id].isDetached
        );
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: updated,
          },
          activeSessionId:
            state.activeSessionId === sessionId
              ? (remainingIds[remainingIds.length - 1] ?? null)
              : state.activeSessionId,
        };
      });

      const title = `${scopeLabel(session.scope)}: ${session.label}`;
      const { window: webview, reused } = await popOut(
        `/chat?sessionId=${encodeURIComponent(sessionId)}`,
        `chat-${sessionId}`,
        {
          title,
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
          return {
            sessions: remaining,
            activeSessionId:
              state.activeSessionId === sessionId
                ? (sessionIds[sessionIds.length - 1] ?? null)
                : state.activeSessionId,
            panelOpen: sessionIds.length > 0 ? state.panelOpen : false,
          };
        }
        updated = { ...session, isDetached: false };
        return {
          sessions: {
            ...state.sessions,
            [sessionId]: updated,
          },
          activeSessionId: sessionId,
          panelOpen: true,
        };
      });
      if (wasCleared) {
        clearLocalChatSessionCleared(sessionId);
      } else if (updated) {
        persistLocalChatSession(updated);
      }
    },

    findSession: (scope, entityId) => {
      return findMatchingSession(get().sessions, scope, entityId);
    },

    reset: () => set(emptyState),
  };
});
