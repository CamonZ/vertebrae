import { describe, it, expect, beforeEach, vi } from "vitest";
import { renderHook, act } from "@testing-library/react";
import type { ChatMessage, ChatSession } from "../bindings";

type EventCallback = (event: { payload: Record<string, unknown> }) => void;

const { mockEvents, eventListeners, emitEvent } = vi.hoisted(() => {
  const listeners: Record<string, EventCallback[]> = {};

  function createEventListener(eventName: string) {
    return {
      listen: vi.fn((callback: EventCallback) => {
        listeners[eventName] = listeners[eventName] || [];
        listeners[eventName].push(callback);
        return Promise.resolve(() => {
          const idx = listeners[eventName].indexOf(callback);
          if (idx > -1) listeners[eventName].splice(idx, 1);
        });
      }),
    };
  }

  return {
    mockEvents: {
      liveChatMessageCreatedEvent: createEventListener(
        "liveChatMessageCreated"
      ),
      liveChatSessionChangedEvent: createEventListener(
        "liveChatSessionChanged"
      ),
    },
    eventListeners: listeners,
    emitEvent: (eventName: string, payload: Record<string, unknown>) => {
      const callbacks = listeners[eventName] || [];
      callbacks.forEach((callback) => callback({ payload }));
    },
  };
});

vi.mock("../bindings", () => ({
  events: mockEvents,
}));

import { useLiveChatChangeListener } from "./useLiveChatChangeListener";
import { useLiveChatStore } from "../stores/liveChatStore";

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "sess-1",
    project_id: "proj-1",
    status: "active",
    session_kind: null,
    started_at: "2026-05-10T12:00:00Z",
    ended_at: null,
    stop_requested_at: null,
    inserted_at: "2026-05-10T12:00:00Z",
    updated_at: "2026-05-10T12:00:00Z",
    ...overrides,
  };
}

function makeMessage(overrides: Partial<ChatMessage> = {}): ChatMessage {
  return {
    id: "msg-1",
    project_id: "proj-1",
    chat_session_id: "sess-1",
    role: "assistant",
    content: "Hello from assistant",
    content_format: "plain",
    client_message_id: null,
    inserted_at: "2026-05-10T12:00:01Z",
    updated_at: "2026-05-10T12:00:01Z",
    ...overrides,
  };
}

describe("useLiveChatChangeListener", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    Object.keys(eventListeners).forEach((key) => {
      eventListeners[key] = [];
    });
    useLiveChatStore.getState().reset();
  });

  it("appends an assistant message to the store on chat_message_created", async () => {
    useLiveChatStore.setState({ currentSession: makeSession() });
    renderHook(() => useLiveChatChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    const assistant = makeMessage({
      id: "msg-assistant-1",
      role: "assistant",
      content: "Hello back!",
    });

    act(() => {
      emitEvent("liveChatMessageCreated", {
        message_id: assistant.id,
        chat_session_id: assistant.chat_session_id,
        client_message_id: null,
        message: assistant,
      });
    });

    const messages = useLiveChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("msg-assistant-1");
    expect(messages[0].role).toBe("assistant");
    expect(messages[0].content).toBe("Hello back!");
    expect(messages[0].pending).toBe(false);
    expect(messages[0].error).toBeNull();
  });

  it("replaces an optimistic user message keyed by client_message_id", async () => {
    useLiveChatStore.setState({
      currentSession: makeSession(),
      messages: [
        {
          id: "live-1",
          role: "user",
          content: "hi",
          content_format: "plain",
          createdAt: "2026-05-10T12:00:00Z",
          pending: true,
          error: null,
        },
      ],
    });

    renderHook(() => useLiveChatChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    const persisted = makeMessage({
      id: "msg-server-1",
      role: "user",
      content: "hi",
      client_message_id: "live-1",
    });

    act(() => {
      emitEvent("liveChatMessageCreated", {
        message_id: persisted.id,
        chat_session_id: persisted.chat_session_id,
        client_message_id: "live-1",
        message: persisted,
      });
    });

    const messages = useLiveChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("msg-server-1");
    expect(messages[0].pending).toBe(false);
  });

  it("is idempotent against duplicate deliveries of the same persisted id", async () => {
    useLiveChatStore.setState({ currentSession: makeSession() });
    renderHook(() => useLiveChatChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    const msg = makeMessage({ id: "msg-dup" });

    act(() => {
      emitEvent("liveChatMessageCreated", {
        message_id: msg.id,
        chat_session_id: msg.chat_session_id,
        client_message_id: null,
        message: msg,
      });
      emitEvent("liveChatMessageCreated", {
        message_id: msg.id,
        chat_session_id: msg.chat_session_id,
        client_message_id: null,
        message: msg,
      });
    });

    const messages = useLiveChatStore.getState().messages;
    expect(messages).toHaveLength(1);
    expect(messages[0].id).toBe("msg-dup");
  });

  it("ignores messages whose session id does not match the current session", async () => {
    useLiveChatStore.setState({
      currentSession: makeSession({ id: "sess-current" }),
    });
    renderHook(() => useLiveChatChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    const msg = makeMessage({
      id: "msg-other",
      chat_session_id: "sess-other",
    });

    act(() => {
      emitEvent("liveChatMessageCreated", {
        message_id: msg.id,
        chat_session_id: msg.chat_session_id,
        client_message_id: null,
        message: msg,
      });
    });

    expect(useLiveChatStore.getState().messages).toHaveLength(0);
  });

  it("ignores the event entirely if message deserialization failed (null message)", async () => {
    useLiveChatStore.setState({ currentSession: makeSession() });
    renderHook(() => useLiveChatChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    act(() => {
      emitEvent("liveChatMessageCreated", {
        message_id: "msg-broken",
        chat_session_id: "sess-1",
        client_message_id: null,
        message: null,
      });
    });

    expect(useLiveChatStore.getState().messages).toHaveLength(0);
  });

  it("upserts the session on chat_session_changed when there is no current session", async () => {
    renderHook(() => useLiveChatChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    const session = makeSession({ id: "sess-new", status: "active" });

    act(() => {
      emitEvent("liveChatSessionChanged", {
        session_id: session.id,
        change_type: "Created",
        session,
      });
    });

    expect(useLiveChatStore.getState().currentSession).toEqual(session);
  });

  it("updates the current session in place when ids match", async () => {
    useLiveChatStore.setState({
      currentSession: makeSession({ id: "sess-1", status: "active" }),
    });
    renderHook(() => useLiveChatChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    const updated = makeSession({ id: "sess-1", status: "ended" });

    act(() => {
      emitEvent("liveChatSessionChanged", {
        session_id: updated.id,
        change_type: "Updated",
        session: updated,
      });
    });

    expect(useLiveChatStore.getState().currentSession?.status).toBe("ended");
  });

  it("does not overwrite the current session with a different session id", async () => {
    const existing = makeSession({ id: "sess-current" });
    useLiveChatStore.setState({ currentSession: existing });
    renderHook(() => useLiveChatChangeListener());
    await act(async () => {
      await Promise.resolve();
    });

    const other = makeSession({ id: "sess-other", status: "ended" });

    act(() => {
      emitEvent("liveChatSessionChanged", {
        session_id: other.id,
        change_type: "Updated",
        session: other,
      });
    });

    expect(useLiveChatStore.getState().currentSession).toEqual(existing);
  });

  it("does not register listeners when disabled", async () => {
    renderHook(() => useLiveChatChangeListener({ enabled: false }));
    await act(async () => {
      await Promise.resolve();
    });

    expect(mockEvents.liveChatMessageCreatedEvent.listen).not.toHaveBeenCalled();
    expect(mockEvents.liveChatSessionChangedEvent.listen).not.toHaveBeenCalled();
  });

  it("cleans up both listeners on unmount", async () => {
    const { unmount } = renderHook(() => useLiveChatChangeListener());

    await act(async () => {
      await Promise.resolve();
    });

    expect(eventListeners["liveChatMessageCreated"]).toHaveLength(1);
    expect(eventListeners["liveChatSessionChanged"]).toHaveLength(1);

    unmount();
    await act(async () => {
      await Promise.resolve();
    });

    expect(eventListeners["liveChatMessageCreated"]).toHaveLength(0);
    expect(eventListeners["liveChatSessionChanged"]).toHaveLength(0);
  });
});
