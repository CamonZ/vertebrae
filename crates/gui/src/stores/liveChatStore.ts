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
  lastError: string | null;
}

interface LiveChatStoreActions {
  setPanelOpen: (open: boolean) => void;
  togglePanel: () => void;
  createSession: () => Promise<ChatSession | null>;
  sendMessage: (content: string) => Promise<ChatMessage | null>;
  appendMessage: (message: LiveChatMessage) => void;
  /**
   * Apply a message received from the server (e.g. via WebSocket). Matches
   * against the optimistic message (by `client_message_id`) and then by
   * persisted `id` so the same message is not displayed twice when both the
   * REST response and the WS broadcast arrive.
   */
  applyRemoteMessage: (
    message: ChatMessage,
    clientMessageId?: string | null
  ) => void;
  upsertSession: (session: ChatSession) => void;
  reset: () => void;
}

export type LiveChatStore = LiveChatStoreState & LiveChatStoreActions;

const initialState: LiveChatStoreState = {
  currentSession: null,
  messages: [],
  creatingSession: false,
  sending: false,
  panelOpen: false,
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

export const useLiveChatStore = create<LiveChatStore>((set, get) => ({
  ...initialState,

  setPanelOpen: (open) => set({ panelOpen: open }),
  togglePanel: () => set((state) => ({ panelOpen: !state.panelOpen })),

  appendMessage: (message) =>
    set((state) => ({ messages: [...state.messages, message] })),

  applyRemoteMessage: (message, clientMessageId) =>
    set((state) => {
      const persisted = toLiveMessage(message);
      const matchClientId =
        clientMessageId ?? message.client_message_id ?? null;

      // Replace by client_message_id (optimistic message) first, then by id
      // (idempotent against duplicate WS deliveries / REST + WS race).
      const existingIndex = state.messages.findIndex((m) => {
        if (matchClientId && m.id === matchClientId) return true;
        if (m.id === persisted.id) return true;
        return false;
      });

      if (existingIndex >= 0) {
        const next = state.messages.slice();
        next[existingIndex] = persisted;
        return { messages: next };
      }
      return { messages: [...state.messages, persisted] };
    }),

  upsertSession: (session) => {
    const { currentSession } = get();
    if (currentSession && currentSession.id !== session.id) return;
    set({ currentSession: session });
  },

  reset: () => set({ ...initialState, messages: [] }),

  createSession: async () => {
    if (get().currentSession) {
      return get().currentSession;
    }
    set({ creatingSession: true, lastError: null });
    const result = await commands.createChatSession();
    if (result.status === "ok") {
      set({ currentSession: result.data, creatingSession: false });
      return result.data;
    }
    set({
      creatingSession: false,
      lastError: result.error.message,
    });
    return null;
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
