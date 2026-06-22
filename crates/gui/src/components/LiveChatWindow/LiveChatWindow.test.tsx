import { describe, it, expect, beforeEach, vi } from "vitest";
import { act, render, screen, waitFor, within } from "@testing-library/react";
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

const mockDetachLiveChat = vi.fn();
vi.mock("../../utils/detachLiveChat", () => ({
  detachLiveChat: () => mockDetachLiveChat(),
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

// The rewritten window renders messages through the unified <Thread> primitive
// (EventLog → EventRow), not per-message data-testids. Message text also leaks
// into the history-drawer session titles, so scope transcript assertions to the
// chat EventLog to avoid matching the drawer copy.
function transcript() {
  const log = document.querySelector(".evlog");
  if (!log) throw new Error("chat transcript (.evlog) not rendered");
  return within(log as HTMLElement);
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
    mockDetachLiveChat.mockReset();
    // Default: no cached session — empty resumable + empty history.
    mockedGetActive.mockResolvedValue({ status: "ok", data: null });
    mockedListSessions.mockResolvedValue({ status: "ok", data: [] });
    mockedDeleteSession.mockResolvedValue({
      status: "ok",
      data: { deleted_session_id: "sess-abc12345", success: true },
    });
    mockedSetActive.mockResolvedValue({ status: "ok", data: null });
  });

  it("renders an empty-state hint when no messages exist", () => {
    render(<LiveChatWindow />);
    expect(
      screen.getByText("Start a live chat")
    ).toBeInTheDocument();
  });

  it("renders assistant markdown prose (**bold** → <strong>)", () => {
    useLiveChatStore.setState({
      currentSession: makeSession(),
      messages: [
        {
          id: "a-md",
          role: "assistant",
          content: "this is **bold** text",
          content_format: "markdown",
          createdAt: "2026-05-10T12:00:00Z",
          pending: false,
          error: null,
        },
      ],
    });

    render(<LiveChatWindow />);

    const strong = screen.getByText("bold");
    expect(strong.tagName).toBe("STRONG");
  });

  it("renders the new header buttons: History, New chat, Detach, Close", () => {
    render(<LiveChatWindow />);
    expect(screen.getByLabelText("Toggle chat history")).toBeInTheDocument();
    expect(screen.getByLabelText("Start new chat")).toBeInTheDocument();
    expect(screen.getByLabelText("Detach live chat")).toBeInTheDocument();
    expect(screen.getByLabelText("Close live chat")).toBeInTheDocument();
  });

  it("standalone mode hides Detach and Close buttons", () => {
    render(<LiveChatWindow standalone />);
    expect(screen.getByLabelText("Toggle chat history")).toBeInTheDocument();
    expect(screen.getByLabelText("Start new chat")).toBeInTheDocument();
    expect(screen.queryByLabelText("Detach live chat")).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Close live chat")).not.toBeInTheDocument();
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

    expect(transcript().getByText("You")).toBeInTheDocument();
    expect(transcript().getByText("hello there")).toBeInTheDocument();
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

  it("disables the send button until the user types something", () => {
    render(<LiveChatWindow />);
    const sendButton = screen.getByLabelText("Send message") as HTMLButtonElement;
    expect(sendButton.disabled).toBe(true);
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

  it("New chat clears current session, messages, and persists null", async () => {
    const user = userEvent.setup();
    const session = makeSession({ id: "sess-clear" });
    useLiveChatStore.setState({
      currentSession: session,
      sessions: [session],
      messages: [
        {
          id: "msg-clear",
          role: "user",
          content: "leftover",
          content_format: "plain",
          createdAt: "2026-05-10T12:00:00Z",
          pending: false,
          error: null,
        },
      ],
    });

    render(<LiveChatWindow />);

    expect(transcript().getByText("leftover")).toBeInTheDocument();

    await user.click(screen.getByLabelText("Start new chat"));

    expect(useLiveChatStore.getState().currentSession).toBeNull();
    expect(useLiveChatStore.getState().messages).toEqual([]);
    expect(mockedSetActive).toHaveBeenCalledWith(null);
    // The transcript is gone (no messages) — empty state shows instead.
    expect(document.querySelector(".evlog")).toBeNull();
    expect(
      screen.getByText("Start a live chat")
    ).toBeInTheDocument();
  });

  it("New chat is disabled when there's nothing to leave", () => {
    render(<LiveChatWindow />);
    const btn = screen.getByLabelText("Start new chat") as HTMLButtonElement;
    expect(btn.disabled).toBe(true);
  });

  it("opens and closes the history drawer", async () => {
    const user = userEvent.setup();
    const session = makeSession({ id: "sess-1" });
    mockedListSessions.mockResolvedValueOnce({
      status: "ok",
      data: [session],
    });

    render(<LiveChatWindow />);

    const drawer = screen.getByTestId("live-chat-history-drawer");
    expect(drawer.getAttribute("aria-hidden")).toBe("true");

    await user.click(screen.getByLabelText("Toggle chat history"));
    expect(drawer.getAttribute("aria-hidden")).toBe("false");

    await user.click(screen.getByLabelText("Close chat history"));
    expect(drawer.getAttribute("aria-hidden")).toBe("true");
  });

  it("drawer renders session rows", async () => {
    const user = userEvent.setup();
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
    await waitFor(() => {
      expect(useLiveChatStore.getState().sessions).toHaveLength(2);
    });

    await user.click(screen.getByLabelText("Toggle chat history"));

    expect(screen.getByTestId("history-row-sess-newer")).toBeInTheDocument();
    expect(screen.getByTestId("history-row-sess-older")).toBeInTheDocument();
  });

  it("clicking a non-active row selects that session and closes the drawer", async () => {
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
    await waitFor(() => {
      expect(useLiveChatStore.getState().sessions).toHaveLength(1);
    });

    await user.click(screen.getByLabelText("Toggle chat history"));

    const row = screen.getByTestId("history-row-sess-past");
    const open = row.querySelector("button");
    expect(open).not.toBeNull();
    await user.click(open!);

    await waitFor(() => {
      expect(mockedListMessages).toHaveBeenCalledWith("sess-past", 200, null);
    });
    expect(mockedSetActive).toHaveBeenCalledWith("sess-past");
    await waitFor(() => {
      expect(transcript().getByText("past transcript")).toBeInTheDocument();
    });

    const drawer = screen.getByTestId("live-chat-history-drawer");
    await waitFor(() => {
      expect(drawer.getAttribute("aria-hidden")).toBe("true");
    });
  });

  it("trash on a row swaps it to inline confirm; confirm deletes; cancel restores", async () => {
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

    await user.click(screen.getByLabelText("Toggle chat history"));

    await user.click(screen.getByLabelText("Delete chat sess-delete"));
    expect(screen.getByText("Delete this chat?")).toBeInTheDocument();

    await user.click(
      screen.getByLabelText("Cancel delete chat sess-delete")
    );
    expect(mockedDeleteSession).not.toHaveBeenCalled();
    expect(screen.queryByText("Delete this chat?")).not.toBeInTheDocument();
    expect(
      screen.getByTestId("history-row-sess-delete")
    ).toBeInTheDocument();

    await user.click(screen.getByLabelText("Delete chat sess-delete"));
    await user.click(
      screen.getByLabelText("Confirm delete chat sess-delete")
    );

    await waitFor(() => {
      expect(mockedDeleteSession).toHaveBeenCalledWith("sess-delete");
      expect(useLiveChatStore.getState().currentSession).toBeNull();
    });
    expect(useLiveChatStore.getState().sessions).toEqual([]);
    expect(screen.queryByText("remove transcript")).not.toBeInTheDocument();
  });

  it("Resume last session link appears when resumableSessionId is set and triggers resume", async () => {
    const user = userEvent.setup();
    const session = makeSession({ id: "sess-resume" });
    mockedGetActive.mockReset();
    mockedGetActive.mockResolvedValue({ status: "ok", data: "sess-resume" });
    mockedGetSession.mockResolvedValueOnce({ status: "ok", data: session });
    mockedListMessages.mockResolvedValueOnce({
      status: "ok",
      data: [
        makeMessage({
          id: "msg-resumed",
          chat_session_id: "sess-resume",
          content: "resumed transcript",
        }),
      ],
    });

    render(<LiveChatWindow />);

    const link = await screen.findByLabelText("Resume last session");
    expect(link).toBeInTheDocument();

    await user.click(link);

    await waitFor(() => {
      expect(mockedGetSession).toHaveBeenCalledWith("sess-resume");
    });
    await waitFor(() => {
      expect(transcript().getByText("resumed transcript")).toBeInTheDocument();
    });
  });

  it("Detach button calls detachLiveChat()", async () => {
    const user = userEvent.setup();
    mockDetachLiveChat.mockResolvedValue(undefined);

    render(<LiveChatWindow />);

    await user.click(screen.getByLabelText("Detach live chat"));
    expect(mockDetachLiveChat).toHaveBeenCalledTimes(1);
  });

  it("standalone mount auto-resumes the cached active session so reply events apply", async () => {
    const session = makeSession({ id: "sess-resume" });
    mockedGetActive.mockReset();
    mockedGetActive.mockResolvedValue({ status: "ok", data: "sess-resume" });
    mockedGetSession.mockResolvedValueOnce({ status: "ok", data: session });
    mockedListMessages.mockResolvedValueOnce({
      status: "ok",
      data: [
        makeMessage({
          id: "msg-prior",
          chat_session_id: "sess-resume",
          content: "prior transcript",
        }),
      ],
    });

    render(<LiveChatWindow standalone />);

    await waitFor(() => {
      expect(useLiveChatStore.getState().currentSession?.id).toBe("sess-resume");
    });
    expect(mockedGetSession).toHaveBeenCalledWith("sess-resume");
    expect(mockedListMessages).toHaveBeenCalledWith("sess-resume", 200, null);
    await waitFor(() =>
      expect(transcript().getByText("prior transcript")).toBeInTheDocument()
    );

    // Now that currentSession is set, a remote reply for that session must
    // render — this is the bug the ticket fixes.
    const reply = makeMessage({
      id: "msg-reply",
      chat_session_id: "sess-resume",
      role: "assistant",
      content: "live reply after detach",
    });
    act(() => {
      useLiveChatStore.getState().applyRemoteMessage(reply, null);
    });

    await waitFor(() =>
      expect(transcript().getByText("Claude")).toBeInTheDocument()
    );
    expect(
      transcript().getByText("live reply after detach")
    ).toBeInTheDocument();
  });

  it("standalone mount with no cached active session shows empty state and does not auto-create", async () => {
    // Default beforeEach already configures getActiveChatSessionId -> null.
    render(<LiveChatWindow standalone />);

    // Allow the mount effect to resolve.
    await waitFor(() => {
      expect(mockedGetActive).toHaveBeenCalled();
    });

    expect(screen.getByText("Start a live chat")).toBeInTheDocument();
    expect(useLiveChatStore.getState().currentSession).toBeNull();
    expect(mockedGetSession).not.toHaveBeenCalled();
    expect(mockedListMessages).not.toHaveBeenCalled();
    expect(mockedCreate).not.toHaveBeenCalled();
    // Resume link must not appear in standalone when there's no cached id.
    expect(screen.queryByLabelText("Resume last session")).not.toBeInTheDocument();
  });

  it("embedded panel does NOT auto-resume — it shows the resume link instead", async () => {
    const session = makeSession({ id: "sess-resume-embedded" });
    mockedGetActive.mockReset();
    mockedGetActive.mockResolvedValue({
      status: "ok",
      data: "sess-resume-embedded",
    });
    // If selectSession were called, these mocks would back it; assert they
    // are NOT touched.
    mockedGetSession.mockResolvedValue({ status: "ok", data: session });
    mockedListMessages.mockResolvedValue({ status: "ok", data: [] });

    render(<LiveChatWindow />);

    // Resume link is the embedded-panel UX — wait for it to appear so we know
    // loadResumableSessionId has resolved.
    const link = await screen.findByLabelText("Resume last session");
    expect(link).toBeInTheDocument();

    // The embedded panel must not have auto-selected the session.
    expect(useLiveChatStore.getState().currentSession).toBeNull();
    expect(mockedGetSession).not.toHaveBeenCalled();
    expect(mockedListMessages).not.toHaveBeenCalled();
  });
});
