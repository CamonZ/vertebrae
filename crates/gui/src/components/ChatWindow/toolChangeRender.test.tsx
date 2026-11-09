import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { chatMessagesToThread } from "./chatMessagesToThread";
import { EventRow } from "../thread/EventRow";
import { EventLog, Thread } from "../thread";
import { ChatSessionContext } from "../thread/toolChange/ChatSessionContext";
import { routeLocalChatAnnotationEvent } from "../../hooks/useLocalChatEventRouter";
import { useChatStore, type ChatMessage } from "../../stores/chatStore";

vi.mock("@pierre/diffs/react", async () => {
  const { createContext } = await import("react");

  return {
    WorkerPoolContext: createContext(undefined),
    CodeView: () => <div data-testid="patch-diff" />,
  };
});

const TS = "2024-01-01T12:00:00Z";
const PATCH = "diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1 +1 @@\n-x\n+y\n";

function renderChat(messages: ChatMessage[]) {
  const thread = chatMessagesToThread(messages, {
    collapsed: new Set<string>(),
  });
  return render(
    <ChatSessionContext.Provider value="chat-1">
      <EventLog mode="bare">
        <Thread
          thread={thread}
          depth={0}
          mode="bare"
          reveal="shallow"
          showHead={false}
          interactive
        />
      </EventLog>
    </ChatSessionContext.Provider>
  );
}

describe("tool change block in the chat transcript", () => {
  beforeEach(() => {
    useChatStore.setState({
      sessions: {
        "chat-1": {
          toolAnnotations: {
            t1: {
              worktree_delta: {
                session_id: "chat-1",
                tool_id: "t1",
                kind: "worktree_delta",
                payload: {
                  patch: PATCH,
                  files: [{ path: "a", status: "modified" }],
                },
              },
            },
          },
        },
      },
    } as never);
  });

  it.each(["Bash", "Read"])(
    "shows under a completed %s call",
    async (toolName) => {
      renderChat([
        { kind: "assistant", text: "go", timestamp: TS, isPartial: false },
        {
          kind: "tool_call",
          toolName,
          toolId: "t1",
          input: '{"command":"echo hi"}',
          timestamp: TS,
        },
        {
          kind: "tool_result",
          toolId: "t1",
          result: "hi",
          isError: false,
          timestamp: TS,
        },
      ]);
      const group = screen.getByRole("button", { name: /1 call for/ });
      expect(group).toHaveAttribute("aria-expanded", "false");
      const diff = await screen.findByTestId("patch-diff");
      expect(diff.closest(".tool-activity-group")).toBeNull();
      expect(screen.getAllByText("1 file changed")).toHaveLength(1);
      fireEvent.click(group);
      fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
      expect(screen.getAllByTestId("patch-diff")).toHaveLength(1);
      fireEvent.click(group);
      expect(diff).toBeInTheDocument();
    }
  );

  it("shows after a live annotation event is routed", () => {
    useChatStore.setState({ sessions: { "chat-1": {} } } as never);
    const annotation = {
      session_id: "chat-1",
      tool_id: "t1",
      kind: "worktree_delta",
      payload: { patch: PATCH, files: [{ path: "a", status: "modified" }] },
    };
    expect(
      routeLocalChatAnnotationEvent({
        session_id: "chat-1",
        annotation,
      } as never)
    ).toBe(true);
    renderChat([
      { kind: "assistant", text: "go", timestamp: TS, isPartial: false },
      {
        kind: "tool_call",
        toolName: "Bash",
        toolId: "t1",
        input: '{"command":"echo hi"}',
        timestamp: TS,
      },
      {
        kind: "tool_result",
        toolId: "t1",
        result: "hi",
        isError: false,
        timestamp: TS,
      },
    ]);
    fireEvent.click(screen.getByRole("button", { name: /1 call for/ }));
    fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
    expect(screen.getByText("1 file changed")).toBeTruthy();
  });
});

it("keeps payload diffs outside nested agent tool groups at either disclosure level", async () => {
  render(
    <EventRow
      type="agent"
      evt="agent"
      tools={[
        {
          type: "tool",
          evt: "payload",
          name: "Edit",
          status: "done",
          activityInput: { name: "Edit", input: { file_path: "a" } },
          payloadDiffs: [{ path: "a", diff: PATCH }],
          recordedResult: "edited",
        },
      ]}
    />
  );
  const group = screen.getByRole("button", { name: /1 call for/ });
  const diff = await screen.findByTestId("patch-diff");
  expect(diff.closest(".tool-activity-group")).toBeNull();
  fireEvent.click(group);
  fireEvent.click(screen.getByRole("button", { name: /Raw arguments/ }));
  expect(screen.getAllByTestId("patch-diff")).toHaveLength(1);
  fireEvent.click(group);
  expect(diff).toBeInTheDocument();
});
