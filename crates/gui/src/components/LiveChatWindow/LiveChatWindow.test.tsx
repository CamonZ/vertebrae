import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ChatMessage, ChatSession } from "../../bindings";

Element.prototype.scrollIntoView = vi.fn();

vi.mock("../../bindings", () => ({
  commands: {
    createChatSession: vi.fn(),
    sendChatMessage: vi.fn(),
  },
}));

import { commands } from "../../bindings";
import { useLiveChatStore } from "../../stores/liveChatStore";
import { LiveChatWindow } from "./LiveChatWindow";

const mockedCreate = vi.mocked(commands.createChatSession);
const mockedSend = vi.mocked(commands.sendChatMessage);

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
  });

  it("renders an empty-state hint when no messages exist", () => {
    render(<LiveChatWindow />);
    expect(
      screen.getByText("Start a sacrum live chat for this project")
    ).toBeInTheDocument();
    expect(screen.getByText("No session yet")).toBeInTheDocument();
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
});
