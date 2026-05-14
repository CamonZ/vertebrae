import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage, ChatSession } from "../../bindings";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../bindings", () => ({
  commands: {
    createChatSession: vi.fn(),
    sendChatMessage: vi.fn(),
    getChatSession: vi.fn(),
    listChatSessions: vi.fn(),
    deleteChatSession: vi.fn(),
    listChatMessages: vi.fn(),
    getActiveChatSessionId: vi.fn(),
    setActiveChatSessionId: vi.fn(),
  },
}));

import { commands } from "../../bindings";
import { useLiveChatStore } from "../../stores/liveChatStore";
import { LiveChatWindow } from "./LiveChatWindow";

const mockedCreate = vi.mocked(commands.createChatSession);
const mockedSend = vi.mocked(commands.sendChatMessage);
const mockedGetSession = vi.mocked(commands.getChatSession);
const mockedListSessions = vi.mocked(commands.listChatSessions);
const mockedDeleteSession = vi.mocked(commands.deleteChatSession);
const mockedListMessages = vi.mocked(commands.listChatMessages);
const mockedGetActive = vi.mocked(commands.getActiveChatSessionId);
const mockedSetActive = vi.mocked(commands.setActiveChatSessionId);

function makeSession(overrides: Partial<ChatSession> = {}): ChatSession {
  return {
    id: "sess-abc12345",
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
    id: "msg-server-1",
    project_id: "proj-1",
    chat_session_id: "sess-abc12345",
    role: "user",
    content: "hello there",
    content_format: "plain",
    client_message_id: null,
    inserted_at: "2026-05-10T12:00:01Z",
    updated_at: "2026-05-10T12:00:01Z",
    ...overrides,
  };
}

describe("LiveChatWindow", () => {
  beforeEach(() => {
    useLiveChatStore.getState().reset();
    mockedCreate.mockReset();
    mockedSend.mockReset();
    mockedGetSession.mockReset();
    mockedListSessions.mockReset();
    mockedDeleteSession.mockReset();
    mockedListMessages.mockReset();
    mockedGetActive.mockReset();
    mockedSetActive.mockReset();
    // Default: no cached session — hydrate is a no-op for the existing tests.
    mockedGetActive.mockResolvedValue({ status: "ok", data: null });
    mockedListSessions.mockResolvedValue({ status: "ok", data: [] });
    mockedDeleteSession.mockResolvedValue({
      status: "ok",
      data: { deleted_session_id: "sess-abc12345", success: true },
    });
    mockedSetActive.mockResolvedValue({ status: "ok", data: null });
  });

  it("renders an empty-state hint when no messages exist", async () => {
    render(<LiveChatWindow />);
    expect(
      screen.getByText("Start a sacrum live chat for this project")
    ).toBeInTheDocument();
    expect(await screen.findByText("No session yet")).toBeInTheDocument();
  });

  it("creates a session and sends the first message end-to-end", async () => {
    const user = userEvent.setup();
    const session = makeSession();
    const message = makeMessage({ content: "hello there" });
    mockedCreate.mockResolvedValueOnce({ status: "ok", data: session });
    mockedSend.mockResolvedValueOnce({ status: "ok", data: message });

    render(<LiveChatWindow />);

    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "hello there");
    await user.click(screen.getByLabelText("Send message"));

    await waitFor(() => {
      expect(mockedCreate).toHaveBeenCalledTimes(1);
    });
    expect(mockedSend).toHaveBeenCalledTimes(1);
    const [sessionId, content, contentFormat, clientId] =
      mockedSend.mock.calls[0];
    expect(sessionId).toBe(session.id);
    expect(content).toBe("hello there");
    expect(contentFormat).toBeNull();
    expect(typeof clientId).toBe("string");

    expect(screen.getByText("hello there")).toBeInTheDocument();
    await waitFor(() =>
      expect(useLiveChatStore.getState().currentSession?.id).toBe(session.id)
    );
    expect((textarea as HTMLTextAreaElement).value).toBe("");
  });

  it("does not create a new session on the second send", async () => {
    const user = userEvent.setup();
    const session = makeSession();
    useLiveChatStore.setState({ currentSession: session });

    mockedSend
      .mockResolvedValueOnce({
        status: "ok",
        data: makeMessage({ id: "m1", content: "first" }),
      })
      .mockResolvedValueOnce({
        status: "ok",
        data: makeMessage({ id: "m2", content: "second" }),
      });

    render(<LiveChatWindow />);

    const textarea = screen.getByLabelText("Message");
    await user.type(textarea, "first");
    await user.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(1));
    expect(mockedCreate).not.toHaveBeenCalled();

    await user.type(textarea, "second");
    await user.click(screen.getByLabelText("Send message"));
    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(2));
    expect(mockedCreate).not.toHaveBeenCalled();
    expect(screen.getByText("first")).toBeInTheDocument();
    expect(screen.getByText("second")).toBeInTheDocument();
  });

  it("shows the error banner and per-message error when send fails", async () => {
    const user = userEvent.setup();
    useLiveChatStore.setState({ currentSession: makeSession() });
    mockedSend.mockResolvedValueOnce({
      status: "error",
      error: { message: "session not found" },
    });

    render(<LiveChatWindow />);

    await user.type(screen.getByLabelText("Message"), "boom");
    await user.click(screen.getByLabelText("Send message"));

    await waitFor(() => {
      expect(screen.getAllByText("session not found").length).toBeGreaterThan(
        0
      );
    });
  });

  it("disables the send button until the user types something", async () => {
    render(<LiveChatWindow />);
    const sendButton = screen.getByLabelText("Send message") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
    expect(await screen.findByText("No session yet")).toBeInTheDocument();
  });

  it("submits via Enter (without shift)", async () => {
    const user = userEvent.setup();
    const session = makeSession();
    mockedCreate.mockResolvedValueOnce({ status: "ok", data: session });
    mockedSend.mockResolvedValueOnce({
      status: "ok",
      data: makeMessage({ content: "via enter" }),
    });

    render(<LiveChatWindow />);
    await user.type(screen.getByLabelText("Message"), "via enter{Enter}");

    await waitFor(() => expect(mockedSend).toHaveBeenCalledTimes(1));
    const [, content] = mockedSend.mock.calls[0];
    expect(content).toBe("via enter");
  });

  it("hydrates the cached session and renders prior messages on mount", async () => {
    const session = makeSession({ id: "sess-restored" });
    const persisted = makeMessage({
      id: "msg-restored-1",
      chat_session_id: "sess-restored",
      role: "user",
      content: "previous user message",
    });
    const persistedAssistant = makeMessage({
      id: "msg-restored-2",
      chat_session_id: "sess-restored",
      role: "assistant",
      content: "previous assistant reply",
    });

    mockedGetActive.mockReset();
    mockedGetActive.mockResolvedValue({ status: "ok", data: "sess-restored" });
    mockedGetSession.mockResolvedValue({ status: "ok", data: session });
    mockedListMessages.mockResolvedValue({
      status: "ok",
      data: [persisted, persistedAssistant],
    });

    render(<LiveChatWindow />);

    await waitFor(() => {
      expect(screen.getByText("previous user message")).toBeInTheDocument();
      expect(screen.getByText("previous assistant reply")).toBeInTheDocument();
    });
    expect(mockedListMessages).toHaveBeenCalledWith(
      "sess-restored",
      200,
      null
    );
    expect(useLiveChatStore.getState().currentSession?.id).toBe(
      "sess-restored"
    );
  });

  it("renders the history control with prior sessions", async () => {
    const newer = makeSession({
      id: "sess-newer",
      updated_at: "2026-05-10T13:00:00Z",
    });
    const older = makeSession({
      id: "sess-older",
      updated_at: "2026-05-10T12:00:00Z",
    });
    mockedListSessions.mockResolvedValueOnce({
      status: "ok",
      data: [newer, older],
    });

    render(<LiveChatWindow />);

    const picker = await screen.findByLabelText("Chat history");
    expect(picker).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /sess-new/ })).toBeInTheDocument();
    expect(screen.getByRole("option", { name: /sess-old/ })).toBeInTheDocument();
  });

  it("opens a past session from the history picker", async () => {
    const user = userEvent.setup();
    const pastSession = makeSession({ id: "sess-past" });
    const pastMessage = makeMessage({
      id: "msg-past",
      chat_session_id: "sess-past",
      content: "past transcript",
    });
    mockedListSessions.mockResolvedValueOnce({
      status: "ok",
      data: [pastSession],
    });
    mockedListMessages.mockResolvedValueOnce({
      status: "ok",
      data: [pastMessage],
    });

    render(<LiveChatWindow />);

    await user.selectOptions(
      await screen.findByLabelText("Chat history"),
      "sess-past"
    );

    await waitFor(() => {
      expect(screen.getByText("past transcript")).toBeInTheDocument();
    });
    expect(mockedListMessages).toHaveBeenCalledWith("sess-past", 200, null);
    expect(mockedSetActive).toHaveBeenCalledWith("sess-past");
  });

  it("cancels and confirms deleting the selected session", async () => {
    const user = userEvent.setup();
    const session = makeSession({ id: "sess-delete" });
    useLiveChatStore.setState({
      currentSession: session,
      sessions: [session],
      messages: [
        {
          id: "msg-delete",
          role: "user",
          content: "remove transcript",
          content_format: "plain",
          createdAt: "2026-05-10T12:00:00Z",
          pending: false,
          error: null,
        },
      ],
    });
    mockedListSessions.mockResolvedValue({ status: "ok", data: [session] });
    mockedDeleteSession.mockResolvedValueOnce({
      status: "ok",
      data: { deleted_session_id: "sess-delete", success: true },
    });

    render(<LiveChatWindow />);

    await user.click(screen.getByLabelText("Delete chat session"));
    expect(
      screen.getByLabelText("Confirm delete chat session")
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText("Cancel delete chat session"));
    expect(mockedDeleteSession).not.toHaveBeenCalled();
    expect(screen.getByText("remove transcript")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Delete chat session"));
    await user.click(screen.getByLabelText("Confirm delete chat session"));

    await waitFor(() => {
      expect(mockedDeleteSession).toHaveBeenCalledWith("sess-delete");
      expect(useLiveChatStore.getState().currentSession).toBeNull();
    });
    expect(useLiveChatStore.getState().sessions).toEqual([]);
    expect(screen.queryByText("remove transcript")).not.toBeInTheDocument();
  });
});
