import { describe, it, expect, beforeEach, vi } from "vitest";
import type { ChatMessage, ChatSession } from "../bindings";

vi.mock("../bindings", () => ({
  commands: {
    createChatSession: vi.fn(),
    sendChatMessage: vi.fn(),
  },
}));

import { commands } from "../bindings";
import { useLiveChatStore, type LiveChatMessage } from "./liveChatStore";

const mockedCreate = vi.mocked(commands.createChatSession);
const mockedSend = vi.mocked(commands.sendChatMessage);

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
    role: "user",
    content: "hello",
    content_format: "plain",
    client_message_id: null,
    inserted_at: "2026-05-10T12:00:01Z",
    updated_at: "2026-05-10T12:00:01Z",
    ...overrides,
  };
}

describe("liveChatStore", () => {
  beforeEach(() => {
    useLiveChatStore.getState().reset();
    mockedCreate.mockReset();
    mockedSend.mockReset();
  });

  describe("createSession", () => {
    it("calls the backend and stores the returned session", async () => {
      const session = makeSession({ id: "sess-42" });
      mockedCreate.mockResolvedValueOnce({ status: "ok", data: session });

      const result = await useLiveChatStore.getState().createSession();

      expect(result).toEqual(session);
      expect(mockedCreate).toHaveBeenCalledTimes(1);
      expect(useLiveChatStore.getState().currentSession).toEqual(session);
      expect(useLiveChatStore.getState().creatingSession).toBe(false);
      expect(useLiveChatStore.getState().lastError).toBeNull();
    });

    it("is idempotent when a session already exists", async () => {
      const existing = makeSession({ id: "sess-existing" });
      useLiveChatStore.setState({ currentSession: existing });

      const result = await useLiveChatStore.getState().createSession();
      expect(result).toEqual(existing);
      expect(mockedCreate).not.toHaveBeenCalled();
    });

    it("records the error message when the backend fails", async () => {
      mockedCreate.mockResolvedValueOnce({
        status: "error",
        error: { message: "nope" },
      });

      const result = await useLiveChatStore.getState().createSession();

      expect(result).toBeNull();
      expect(useLiveChatStore.getState().currentSession).toBeNull();
      expect(useLiveChatStore.getState().lastError).toBe("nope");
      expect(useLiveChatStore.getState().creatingSession).toBe(false);
    });
  });

  describe("sendMessage", () => {
    it("creates a session on the first send if none exists", async () => {
      const session = makeSession();
      mockedCreate.mockResolvedValueOnce({ status: "ok", data: session });
      mockedSend.mockResolvedValueOnce({
        status: "ok",
        data: makeMessage({ content: "hi" }),
      });

      await useLiveChatStore.getState().sendMessage("hi");

      expect(mockedCreate).toHaveBeenCalledTimes(1);
      expect(mockedSend).toHaveBeenCalledTimes(1);
      const [sessionId, content, contentFormat, clientId] =
        mockedSend.mock.calls[0];
      expect(sessionId).toBe(session.id);
      expect(content).toBe("hi");
      expect(contentFormat).toBeNull();
      expect(typeof clientId).toBe("string");
    });

    it("appends an optimistic user message immediately and replaces with the persisted one", async () => {
      const session = makeSession();
      useLiveChatStore.setState({ currentSession: session });

      let resolveSend: (value: {
        status: "ok";
        data: ChatMessage;
      }) => void = () => {};
      mockedSend.mockReturnValueOnce(
        new Promise((resolve) => {
          resolveSend = resolve;
        }) as ReturnType<typeof commands.sendChatMessage>
      );

      const promise = useLiveChatStore.getState().sendMessage("hello world");

      // Optimistic insert is visible before the await resolves.
      const optimisticState = useLiveChatStore.getState();
      expect(optimisticState.messages).toHaveLength(1);
      expect(optimisticState.messages[0].content).toBe("hello world");
      expect(optimisticState.messages[0].pending).toBe(true);
      expect(optimisticState.sending).toBe(true);

      const persisted = makeMessage({
        id: "msg-server-1",
        content: "hello world",
      });
      resolveSend({ status: "ok", data: persisted });
      await promise;

      const finalState = useLiveChatStore.getState();
      expect(finalState.messages).toHaveLength(1);
      expect(finalState.messages[0].id).toBe("msg-server-1");
      expect(finalState.messages[0].pending).toBe(false);
      expect(finalState.sending).toBe(false);
    });

    it("marks the optimistic message as failed when the backend errors out", async () => {
      const session = makeSession();
      useLiveChatStore.setState({ currentSession: session });

      mockedSend.mockResolvedValueOnce({
        status: "error",
        error: { message: "boom" },
      });

      const result = await useLiveChatStore.getState().sendMessage("nope");

      expect(result).toBeNull();
      const state = useLiveChatStore.getState();
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].error).toBe("boom");
      expect(state.messages[0].pending).toBe(false);
      expect(state.lastError).toBe("boom");
      expect(state.sending).toBe(false);
    });

    it("only stamps the failing optimistic message when other messages already exist", async () => {
      const session = makeSession();
      const existing: LiveChatMessage = {
        id: "msg-prev",
        role: "assistant",
        content: "previous reply",
        content_format: "plain",
        createdAt: "2026-05-10T11:59:00Z",
        pending: false,
        error: null,
      };
      useLiveChatStore.setState({
        currentSession: session,
        messages: [existing],
      });

      mockedSend.mockResolvedValueOnce({
        status: "error",
        error: { message: "boom" },
      });

      await useLiveChatStore.getState().sendMessage("nope");

      const messages = useLiveChatStore.getState().messages;
      expect(messages).toHaveLength(2);
      expect(messages[0]).toEqual(existing);
      expect(messages[0].error).toBeNull();
      expect(messages[1].error).toBe("boom");
      expect(messages[1].pending).toBe(false);
    });

    it("ignores empty / whitespace-only content", async () => {
      const result = await useLiveChatStore.getState().sendMessage("   ");
      expect(result).toBeNull();
      expect(mockedCreate).not.toHaveBeenCalled();
      expect(mockedSend).not.toHaveBeenCalled();
      expect(useLiveChatStore.getState().messages).toHaveLength(0);
    });

    it("does not send if session creation fails", async () => {
      mockedCreate.mockResolvedValueOnce({
        status: "error",
        error: { message: "no project" },
      });

      const result = await useLiveChatStore.getState().sendMessage("hello");

      expect(result).toBeNull();
      expect(mockedSend).not.toHaveBeenCalled();
      expect(useLiveChatStore.getState().lastError).toBe("no project");
    });
  });

  describe("appendMessage", () => {
    it("appends a fully-formed message at the end", () => {
      useLiveChatStore.getState().appendMessage({
        id: "m-1",
        role: "assistant",
        content: "hi from server",
        content_format: "plain",
        createdAt: "2026-05-10T12:00:02Z",
        pending: false,
        error: null,
      });

      const messages = useLiveChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].content).toBe("hi from server");
    });
  });

  describe("applyRemoteMessage", () => {
    it("appends a remote message when there's no matching local message", () => {
      const incoming = makeMessage({
        id: "msg-assistant-1",
        role: "assistant",
        content: "hello from server",
      });

      useLiveChatStore.getState().applyRemoteMessage(incoming);

      const messages = useLiveChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-assistant-1");
      expect(messages[0].role).toBe("assistant");
      expect(messages[0].pending).toBe(false);
    });

    it("replaces the optimistic message matched by client_message_id", () => {
      useLiveChatStore.setState({
        messages: [
          {
            id: "client-abc",
            role: "user",
            content: "hi",
            content_format: "plain",
            createdAt: "2026-05-10T12:00:00Z",
            pending: true,
            error: null,
          },
        ],
      });

      const persisted = makeMessage({
        id: "msg-server",
        client_message_id: "client-abc",
      });

      useLiveChatStore.getState().applyRemoteMessage(persisted, "client-abc");

      const messages = useLiveChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-server");
      expect(messages[0].pending).toBe(false);
    });

    it("falls back to the message.client_message_id when no override is given", () => {
      useLiveChatStore.setState({
        messages: [
          {
            id: "client-fallback",
            role: "user",
            content: "hi",
            content_format: "plain",
            createdAt: "2026-05-10T12:00:00Z",
            pending: true,
            error: null,
          },
        ],
      });

      const persisted = makeMessage({
        id: "msg-server-2",
        client_message_id: "client-fallback",
      });

      useLiveChatStore.getState().applyRemoteMessage(persisted);

      const messages = useLiveChatStore.getState().messages;
      expect(messages).toHaveLength(1);
      expect(messages[0].id).toBe("msg-server-2");
    });

    it("is idempotent against duplicate deliveries (same persisted id)", () => {
      const msg = makeMessage({ id: "msg-dup" });
      useLiveChatStore.getState().applyRemoteMessage(msg);
      useLiveChatStore.getState().applyRemoteMessage(msg);

      expect(useLiveChatStore.getState().messages).toHaveLength(1);
    });

    it("does not mutate the previous messages array when replacing in place", () => {
      useLiveChatStore.setState({
        messages: [
          {
            id: "client-ref",
            role: "user",
            content: "hi",
            content_format: "plain",
            createdAt: "2026-05-10T12:00:00Z",
            pending: true,
            error: null,
          },
        ],
      });
      const before = useLiveChatStore.getState().messages;

      const persisted = makeMessage({
        id: "msg-server-ref",
        client_message_id: "client-ref",
      });
      useLiveChatStore.getState().applyRemoteMessage(persisted, "client-ref");

      const after = useLiveChatStore.getState().messages;
      expect(after).not.toBe(before);
      expect(before[0].id).toBe("client-ref");
      expect(before[0].pending).toBe(true);
    });
  });

  describe("upsertSession", () => {
    it("sets the session when none exists", () => {
      const session = makeSession({ id: "sess-x" });
      useLiveChatStore.getState().upsertSession(session);
      expect(useLiveChatStore.getState().currentSession).toEqual(session);
    });

    it("updates the session in place when ids match", () => {
      const session = makeSession({ id: "sess-1", status: "active" });
      useLiveChatStore.setState({ currentSession: session });
      const updated = makeSession({ id: "sess-1", status: "ended" });
      useLiveChatStore.getState().upsertSession(updated);
      expect(useLiveChatStore.getState().currentSession?.status).toBe("ended");
    });

    it("does not overwrite a different current session", () => {
      const current = makeSession({ id: "sess-current" });
      useLiveChatStore.setState({ currentSession: current });
      const other = makeSession({ id: "sess-other" });
      useLiveChatStore.getState().upsertSession(other);
      expect(useLiveChatStore.getState().currentSession).toEqual(current);
    });
  });

  describe("panel visibility", () => {
    it("toggles the panel open state", () => {
      expect(useLiveChatStore.getState().panelOpen).toBe(false);
      useLiveChatStore.getState().togglePanel();
      expect(useLiveChatStore.getState().panelOpen).toBe(true);
      useLiveChatStore.getState().setPanelOpen(false);
      expect(useLiveChatStore.getState().panelOpen).toBe(false);
    });
  });
});
