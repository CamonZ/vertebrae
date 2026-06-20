import { create } from "zustand";
import { popOut } from "../utils/popOut";
import { stashChatSession } from "../utils/chatStash";
import { scopeLabel } from "../utils/chatContext";

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
    }
  | {
      kind: "tool_result";
      toolId: string;
      result: string;
      isError: boolean;
      timestamp: string;
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
  /** Model name reported by the Claude CLI (from init or per-turn usage) */
  model?: string;
  /** Latest per-turn context utilization for the badge */
  tokenUsage?: { used: number; max: number };
  /** Whether this session is detached into a standalone pop-out window */
  isDetached?: boolean;
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
  /** Add a message to a session */
  addMessage: (sessionId: string, message: ChatMessage) => void;
  /** Update the last assistant message (for streaming) */
  updateLastAssistantMessage: (sessionId: string, text: string) => void;
  /** Finalize the last partial assistant message */
  finalizeLastAssistantMessage: (sessionId: string, text: string) => void;
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
  /** Set the latest per-turn context utilization */
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

const initialState: ChatStoreState = {
  sessions: {},
  activeSessionId: null,
  panelOpen: false,
};

function generateSessionId(): string {
  return `chat-${Date.now()}-${Math.random().toString(36).substring(2, 9)}`;
}

/**
 * Get the parent scope for widening.
 */
export function getParentScope(scope: ChatScope): ChatScope | null {
  return SCOPE_HIERARCHY[scope];
}

export const useChatStore = create<ChatStore>((set, get) => ({
  ...initialState,

  // Actions
  openSession: (scope, entityId, label, projectPath) => {
    // Check if a session already exists for this scope+entity
    const existing = get().findSession(scope, entityId);
    if (existing) {
      set({ activeSessionId: existing, panelOpen: true });
      return existing;
    }

    const id = generateSessionId();
    const session: ChatSession = {
      id,
      scope,
      entityId,
      label,
      messages: [],
      status: "open",
      claudeSessionId: null,
      claudeConversationId: null,
      contextSummary: null,
      projectPath,
    };

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
      const sessionIds = Object.keys(remaining);
      const newActiveId =
        state.activeSessionId === sessionId
          ? sessionIds.length > 0
            ? sessionIds[sessionIds.length - 1]
            : null
          : state.activeSessionId;

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

  addMessage: (sessionId, message) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            messages: [...session.messages, message],
          },
        },
      };
    });
  },

  updateLastAssistantMessage: (sessionId, text) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      const messages = [...session.messages];
      const last = messages[messages.length - 1];
      if (last?.kind === "assistant" && last.isPartial) {
        messages[messages.length - 1] = { ...last, text: last.text + text };
      } else {
        messages.push({
          kind: "assistant",
          text,
          timestamp: new Date().toISOString(),
          isPartial: true,
        });
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, messages },
        },
      };
    });
  },

  finalizeLastAssistantMessage: (sessionId, text) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      const messages = [...session.messages];
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
          timestamp: new Date().toISOString(),
          isPartial: false,
        });
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, messages },
        },
      };
    });
  },

  setClaudeSessionId: (sessionId, claudeSessionId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, claudeSessionId },
        },
      };
    });
  },

  setClaudeConversationId: (sessionId, conversationId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            claudeConversationId: conversationId,
          },
        },
      };
    });
  },

  setContextSummary: (sessionId, summary) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, contextSummary: summary },
        },
      };
    });
  },

  setSessionModel: (sessionId, model) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session || session.model === model) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, model },
        },
      };
    });
  },

  setSessionTokenUsage: (sessionId, usage) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      if (
        session.tokenUsage?.used === usage.used &&
        session.tokenUsage?.max === usage.max
      ) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, tokenUsage: usage },
        },
      };
    });
  },

  setSessionUsage: (sessionId, model, usage) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      if (
        session.model === model &&
        session.tokenUsage?.used === usage.used &&
        session.tokenUsage?.max === usage.max
      ) {
        return state;
      }
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, model, tokenUsage: usage },
        },
      };
    });
  },

  markSessionClosed: (sessionId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, status: "closed" },
        },
      };
    });
  },

  clearMessages: (sessionId) => {
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, messages: [] },
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
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: {
            ...session,
            scope: newScope,
            entityId: newEntityId,
            label: newLabel,
          },
        },
      };
    });
  },

  detachSession: async (sessionId) => {
    const session = get().sessions[sessionId];
    if (!session || session.isDetached) return;

    // Stash the full session so the pop-out can seed its empty store
    // synchronously before first paint. The existing claudeSessionId is
    // carried across so useScopedChat does not double-create the backend
    // Claude session.
    stashChatSession({ ...session, isDetached: true });

    set((state) => {
      const s = state.sessions[sessionId];
      if (!s) return state;
      const remainingIds = Object.keys(state.sessions).filter(
        (id) => id !== sessionId && !state.sessions[id].isDetached
      );
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...s, isDetached: true },
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
    set((state) => {
      const session = state.sessions[sessionId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [sessionId]: { ...session, isDetached: false },
        },
        activeSessionId: sessionId,
        panelOpen: true,
      };
    });
  },

  findSession: (scope, entityId) => {
    const { sessions } = get();
    for (const [id, session] of Object.entries(sessions)) {
      if (
        session.scope === scope &&
        session.entityId === entityId &&
        session.status === "open"
      ) {
        return id;
      }
    }
    return null;
  },

  reset: () => set(initialState),
}));
