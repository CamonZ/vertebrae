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
  messages: LiveChatMessage[];
  creatingSession: boolean;
  sending: boolean;
  panelOpen: boolean;
  hydrated: boolean;
  lastError: string | null;
}

interface LiveChatStoreActions {
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
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

const initialState: LiveChatStoreState = {
  currentSession: null,
  messages: [],
  creatingSession: false,
  sending: false,
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

let inflightHydrate: Promise<ChatSession | null> | null = null;
let hydrateGeneration = 0;

export const useLiveChatStore = create<LiveChatStore>((set, get) => ({
  ...initialState,

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  applyRemoteMessage: (message, clientMessageId) =>
    set((state) => ({
      messages: mergeMessage(state.messages, message, clientMessageId ?? null),
    })),

  upsertSession: (session) => {
    const { currentSession } = get();
    if (currentSession && currentSession.id !== session.id) return;
    set({ currentSession: session });
  },

  reset: () => {
    hydrateGeneration += 1;
    inflightHydrate = null;
    set({ ...initialState, messages: [] });
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
        creatingSession: false,
        hydrated: true,
      });
      void commands.setActiveChatSessionId(result.data.id).catch(() => {
        /* persistence failure is non-fatal — chat works without the cache */
      });
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
        void commands.setActiveChatSessionId(null).catch(() => {
          /* persistence failure is non-fatal — chat works without the cache */
        });
        set({ hydrated: true });
        return null;
      }

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
