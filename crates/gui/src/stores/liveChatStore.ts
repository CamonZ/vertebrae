import { create } from "zustand";
import { commands } from "../bindings";
import type { ChatMessage, ChatSession } from "../bindings";

export interface LiveChatMessage {
  id: string;
  role: string;
  content: string;
  content_format: string | null;
  createdAt: string;
  pending: boolean;
  error: string | null;
}

interface LiveChatStoreState {
  currentSession: ChatSession | null;
  sessions: ChatSession[];
  messages: LiveChatMessage[];
  creatingSession: boolean;
  sending: boolean;
  loadingSessions: boolean;
  deletingSessionId: string | null;
  panelOpen: boolean;
  hydrated: boolean;
  lastError: string | null;
}

interface LiveChatStoreActions {
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  loadSessions: (limit?: number) => Promise<ChatSession[] | null>;
  selectSession: (chatSessionId: string) => Promise<ChatSession | null>;
  deleteSession: (chatSessionId: string) => Promise<boolean>;
  createSession: () => Promise<ChatSession | null>;
  sendMessage: (content: string) => Promise<ChatMessage | null>;
  appendMessage: (message: LiveChatMessage) => void;
  applyRemoteMessage: (
    message: ChatMessage,
    clientMessageId?: string | null
  ) => void;
  upsertSession: (session: ChatSession) => void;
  hydrate: () => Promise<ChatSession | null>;
  reset: () => void;
}

export type LiveChatStore = LiveChatStoreState & LiveChatStoreActions;

const HYDRATE_MESSAGE_LIMIT = 200;
const SESSION_HISTORY_LIMIT = 25;

const initialState: LiveChatStoreState = {
  currentSession: null,
  sessions: [],
  messages: [],
  creatingSession: false,
  sending: false,
  loadingSessions: false,
  deletingSessionId: null,
  panelOpen: false,
  hydrated: false,
  lastError: null,
};

function nowIso(): string {
  return new Date().toISOString();
}

let counter = 0;
function clientId(): string {
  counter += 1;
  return `live-${Date.now()}-${counter}`;
}

function toLiveMessage(message: ChatMessage): LiveChatMessage {
  return {
    id: message.id,
    role: message.role,
    content: message.content,
    content_format: message.content_format,
    createdAt: message.inserted_at ?? nowIso(),
    pending: false,
    error: null,
  };
}

// Replace by client_message_id (matches an optimistic local message) first,
// then by persisted id (idempotent against duplicate WS deliveries / REST + WS
// race). If neither matches, append.
function mergeMessage(
  messages: LiveChatMessage[],
  message: ChatMessage,
  clientMessageId: string | null
): LiveChatMessage[] {
  const persisted = toLiveMessage(message);
  const matchClientId = clientMessageId ?? message.client_message_id ?? null;
  const idx = messages.findIndex(
    (m) =>
      (matchClientId !== null && m.id === matchClientId) ||
      m.id === persisted.id
  );
  if (idx >= 0) {
    const next = messages.slice();
    next[idx] = persisted;
    return next;
  }
  return [...messages, persisted];
}

function sessionSortTime(session: ChatSession): number {
  const raw =
    session.updated_at ??
    session.inserted_at ??
    session.started_at ??
    session.ended_at ??
    null;
  if (!raw) return 0;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? 0 : time;
}

function sortSessionsNewestFirst(sessions: ChatSession[]): ChatSession[] {
  return sessions
    .slice()
    .sort((a, b) => sessionSortTime(b) - sessionSortTime(a));
}

function upsertSessionList(
  sessions: ChatSession[],
  session: ChatSession
): ChatSession[] {
  const next = sessions.filter((s) => s.id !== session.id);
  next.push(session);
  return sortSessionsNewestFirst(next).slice(0, SESSION_HISTORY_LIMIT);
}

function persistActiveSessionId(chatSessionId: string | null): void {
  void commands.setActiveChatSessionId(chatSessionId).catch(() => {
    // Persistence is best-effort; chat remains usable without the local cache.
  });
}

let inflightHydrate: Promise<ChatSession | null> | null = null;
let hydrateGeneration = 0;

export const useLiveChatStore = create<LiveChatStore>((set, get) => ({
  ...initialState,

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  applyRemoteMessage: (message, clientMessageId) => {
    const currentSession = get().currentSession;
    if (!currentSession || currentSession.id !== message.chat_session_id) {
      return;
    }

    set((state) => ({
      messages: mergeMessage(state.messages, message, clientMessageId ?? null),
    }));
  },

  upsertSession: (session) => {
    set((state) => ({
      sessions: upsertSessionList(state.sessions, session),
      currentSession:
        state.currentSession?.id === session.id ? session : state.currentSession,
    }));
  },

  reset: () => {
    hydrateGeneration += 1;
    inflightHydrate = null;
    set({ ...initialState, messages: [] });
  },

  loadSessions: async (limit = SESSION_HISTORY_LIMIT) => {
    set({ loadingSessions: true, lastError: null });
    const result = await commands.listChatSessions(limit);

    if (result.status === "ok") {
      const sessions = sortSessionsNewestFirst(result.data);
      set({ sessions, loadingSessions: false });
      return sessions;
    }

    set({
      loadingSessions: false,
      lastError: result.error.message,
    });
    return null;
  },

  selectSession: async (chatSessionId) => {
    if (get().currentSession?.id === chatSessionId) {
      return get().currentSession;
    }

    hydrateGeneration += 1;
    inflightHydrate = null;
    const generation = hydrateGeneration;
    const isStale = () => generation !== hydrateGeneration;

    set({ lastError: null });

    let session =
      get().sessions.find((candidate) => candidate.id === chatSessionId) ?? null;

    if (!session) {
      const sessionResult = await commands.getChatSession(chatSessionId);
      if (isStale()) return null;
      if (sessionResult.status !== "ok") {
        set({ lastError: sessionResult.error.message });
        return null;
      }
      session = sessionResult.data;
    }

    if (!session) {
      set((state) => ({
        sessions: state.sessions.filter((s) => s.id !== chatSessionId),
        lastError: "Chat session no longer exists",
      }));
      return null;
    }

    set((state) => ({
      currentSession: session,
      sessions: upsertSessionList(state.sessions, session),
      messages: [],
      hydrated: false,
    }));
    persistActiveSessionId(session.id);

    const messagesResult = await commands.listChatMessages(
      session.id,
      HYDRATE_MESSAGE_LIMIT,
      null
    );
    if (isStale()) return null;

    if (messagesResult.status !== "ok") {
      set({ hydrated: true, lastError: messagesResult.error.message });
      return session;
    }

    set((current) => {
      if (current.currentSession?.id !== session.id) return current;

      let merged = current.messages;
      for (const m of messagesResult.data) {
        merged = mergeMessage(merged, m, null);
      }
      return {
        messages: merged,
        hydrated: true,
      };
    });

    return session;
  },

  deleteSession: async (chatSessionId) => {
    set({ deletingSessionId: chatSessionId, lastError: null });
    const result = await commands.deleteChatSession(chatSessionId);

    if (result.status !== "ok") {
      set({
        deletingSessionId: null,
        lastError: result.error.message,
      });
      return false;
    }

    if (!result.data.success) {
      set({
        deletingSessionId: null,
        lastError: "Failed to delete chat session",
      });
      return false;
    }

    const deletedSessionId = result.data.deleted_session_id;
    const isActive = get().currentSession?.id === deletedSessionId;

    if (isActive) {
      hydrateGeneration += 1;
      inflightHydrate = null;
      persistActiveSessionId(null);
    }

    set((state) => ({
      sessions: state.sessions.filter((s) => s.id !== deletedSessionId),
      currentSession: isActive ? null : state.currentSession,
      messages: isActive ? [] : state.messages,
      hydrated: isActive ? true : state.hydrated,
      deletingSessionId: null,
    }));
    return true;
  },

  createSession: async () => {
    if (get().currentSession) {
      return get().currentSession;
    }
    set({ creatingSession: true, lastError: null });
    const result = await commands.createChatSession();
    if (result.status === "ok") {
      set({
        currentSession: result.data,
        sessions: upsertSessionList(get().sessions, result.data),
        creatingSession: false,
        hydrated: true,
      });
      persistActiveSessionId(result.data.id);
      return result.data;
    }
    set({
      creatingSession: false,
      lastError: result.error.message,
    });
    return null;
  },

  hydrate: async () => {
    if (get().hydrated) return get().currentSession;
    if (inflightHydrate) return inflightHydrate;

    const generation = hydrateGeneration;
    const isStale = () => generation !== hydrateGeneration;

    const hydratePromise = (async () => {
      set({ lastError: null });

      const cachedResult = await commands.getActiveChatSessionId();
      if (isStale()) return null;
      if (cachedResult.status !== "ok" || !cachedResult.data) {
        set({ hydrated: true });
        return null;
      }
      const cachedSessionId = cachedResult.data;

      const sessionResult = await commands.getChatSession(cachedSessionId);
      if (isStale()) return null;
      if (sessionResult.status !== "ok") {
        set({ hydrated: true, lastError: sessionResult.error.message });
        return null;
      }
      const session = sessionResult.data;
      if (!session) {
        persistActiveSessionId(null);
        set({ hydrated: true });
        return null;
      }

      set((current) => ({
        currentSession: session,
        sessions: upsertSessionList(current.sessions, session),
      }));

      const messagesResult = await commands.listChatMessages(
        session.id,
        HYDRATE_MESSAGE_LIMIT,
        null
      );
      if (isStale()) return null;
      if (messagesResult.status !== "ok") {
        set({
          hydrated: true,
          currentSession: session,
          lastError: messagesResult.error.message,
        });
        return session;
      }

      // Merge through `mergeMessage` so any WebSocket events that arrived
      // during the hydrate fetches are preserved and deduped consistently.
      set((current) => {
        if (current.currentSession?.id !== session.id) return current;

        let merged = current.messages;
        for (const m of messagesResult.data) {
          merged = mergeMessage(merged, m, null);
        }
        return {
          currentSession: session,
          messages: merged,
          hydrated: true,
        };
      });

      return session;
    })();
    inflightHydrate = hydratePromise;

    try {
      return await hydratePromise;
    } finally {
      if (inflightHydrate === hydratePromise) {
        inflightHydrate = null;
      }
    }
  },

  sendMessage: async (content) => {
    const trimmed = content.trim();
    if (!trimmed) return null;

    let session = get().currentSession;
    if (!session) {
      session = await get().createSession();
      if (!session) return null;
    }

    const optimistic: LiveChatMessage = {
      id: clientId(),
      role: "user",
      content: trimmed,
      content_format: "plain",
      createdAt: nowIso(),
      pending: true,
      error: null,
    };

    set((state) => ({
      messages: [...state.messages, optimistic],
      sending: true,
      lastError: null,
    }));

    const result = await commands.sendChatMessage(
      session.id,
      trimmed,
      null,
      optimistic.id
    );

    if (result.status === "ok") {
      get().applyRemoteMessage(result.data, optimistic.id);
      set({ sending: false });
      return result.data;
    }

    set((state) => ({
      sending: false,
      lastError: result.error.message,
      messages: state.messages.map((m) =>
        m.id === optimistic.id
          ? { ...m, pending: false, error: result.error.message }
          : m
      ),
    }));
    return null;
  },
}));
