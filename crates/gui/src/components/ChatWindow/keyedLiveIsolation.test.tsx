import { act, cleanup, render } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { ChatMessages } from "./ChatMessages";
import { useChatStore, type ChatMessage } from "../../stores/chatStore";
import { materializeLiveAssistantMessages } from "../../stores/liveAssistantMessages";

const counts = vi.hoisted(() => ({ conversions: 0, rows: 0, threads: 0 }));

vi.mock("./chatMessagesToThread", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("./chatMessagesToThread")>();
  return {
    ...original,
    chatMessagesToThread: (
      ...args: Parameters<typeof original.chatMessagesToThread>
    ) => {
      counts.conversions++;
      counts.rows += args[0].length;
      return original.chatMessagesToThread(...args);
    },
  };
});

vi.mock("../thread", async (importOriginal) => {
  const original = await importOriginal<typeof import("../thread")>();
  return {
    ...original,
    Thread: (props: Parameters<typeof original.Thread>[0]) => {
      counts.threads++;
      return <original.Thread {...props} />;
    },
  };
});

const timestamp = "2026-11-03T12:00:00Z";

function delta(
  itemId: string,
  text: string,
  turnId = "turn"
): Extract<ChatMessage, { kind: "assistant" }> {
  return {
    kind: "assistant",
    itemId,
    turnId,
    text,
    timestamp,
    lifecycle: "streaming",
    isPartial: true,
  };
}

function Surface({ id }: { id: string }) {
  const messages = useChatStore((s) => s.sessions[id].messages);

  return (
    <ChatMessages
      sessionId={id}
      messages={messages}
      assistantLabel="Agent"
      isEmpty={false}
      isActive
      isWaiting={false}
      streamingAssistant={null}
    />
  );
}

afterEach(() => {
  cleanup();
  useChatStore.getState().reset();
});

it.each([0, 100, 500, 2000])(
  "isolates 60 separately published deltas from %i completed rows",
  (historySize) => {
    const store = useChatStore.getState();
    const id = store.openSession("Isolation");

    const history: ChatMessage[] = Array.from(
      { length: historySize },
      (_, i) => ({
        kind: "assistant",
        itemId: `history-${i}`,
        text: `Completed ${i}`,
        timestamp,
        lifecycle: "completed",
      })
    );

    useChatStore.setState((s) => ({
      sessions: {
        ...s.sessions,
        [id]: { ...s.sessions[id], messages: history },
      },
    }));

    store.addMessage(id, delta("a", "first"));
    store.addMessage(id, {
      kind: "tool_call",
      toolId: "tool",
      toolName: "Bash",
      input: '{"command":"true"}',
      timestamp,
    });
    store.addMessage(id, delta("b", "second"));

    const root = render(<Surface id={id} />);
    const slots = useChatStore.getState().sessions[id].messages;
    const before = { ...counts };

    for (let i = 0; i < 60; i++)
      act(() => store.addMessage(id, delta(i % 2 ? "b" : "a", " chunk")));

    expect(useChatStore.getState().sessions[id].messages).toBe(slots);
    expect(counts).toEqual(before);
    expect(
      root.container.querySelectorAll(".evprose--plain")[0].textContent
    ).toBe("first" + " chunk".repeat(30));
    expect(
      root.container.querySelectorAll(".evprose--plain")[1].textContent
    ).toBe("second" + " chunk".repeat(30));

    act(() => store.completeAssistantMessage(id, "turn", "a", "authoritative"));
    act(() => store.interruptStreamingAssistant(id, "turn", "b"));

    const final = useChatStore.getState().sessions[id];
    expect(final.messages.slice(-3)).toEqual([
      expect.objectContaining({
        itemId: "a",
        text: "authoritative",
        lifecycle: "completed",
      }),
      expect.objectContaining({ toolId: "tool" }),
      expect.objectContaining({
        itemId: "b",
        text: "second" + " chunk".repeat(30),
        lifecycle: "interrupted",
      }),
    ]);

    act(() => store.addMessage(id, delta("a", "late")));

    expect(
      materializeLiveAssistantMessages(useChatStore.getState().sessions[id])
        .messages
    ).toEqual(final.messages);
  }
);

it("retains received live content across tool boundaries and authoritative empty snapshots", () => {
  const store = useChatStore.getState();
  const id = store.openSession("Boundaries");

  store.addMessage(id, delta("same", "x"));
  store.addMessage(id, delta("same", "x"));
  store.addMessage(id, {
    kind: "tool_result",
    toolId: "tool",
    result: "done",
    isError: false,
    timestamp,
  });
  store.addMessage(id, delta("same", "x"));
  store.completeAssistantMessage(id, "turn", "same", "");

  expect(useChatStore.getState().sessions[id].messages[0]).toMatchObject({
    text: "",
    lifecycle: "completed",
  });

  store.addMessage(id, delta("same", "new turn", "other"));
  store.addMessage(id, delta("same", " continued", "other"));
  store.interruptStreamingAssistant(id, "other");

  expect(useChatStore.getState().sessions[id].messages.at(-1)).toMatchObject({
    text: "new turn continued",
    lifecycle: "interrupted",
  });

  store.clearMessages(id);

  expect(
    useChatStore.getState().sessions[id].liveAssistantMessages
  ).toBeUndefined();
});

it("does not replace completed prose when a later turn reuses an item id", () => {
  const store = useChatStore.getState();
  const id = store.openSession("Reused item");

  store.addMessage(id, {
    ...delta("same", "Completed original"),
    lifecycle: "completed",
    isPartial: false,
  });
  store.addMessage(id, { kind: "user", text: "Next turn", timestamp });
  store.addMessage(id, delta("same", "New live", "next"));

  const root = render(<Surface id={id} />);

  act(() => store.addMessage(id, delta("same", " continued", "next")));

  expect(root.container.querySelector(".markdown-content")?.textContent).toBe(
    "Completed original"
  );

  expect(root.container.querySelector(".evprose--plain")?.textContent).toBe(
    "New live continued"
  );
});

it("keeps existing live slots isolated on the first delta after a tool boundary", () => {
  const store = useChatStore.getState();
  const id = store.openSession("Tool boundary isolation");

  store.addMessage(id, delta("a", "x"));
  store.addMessage(id, delta("a", "x"));

  const root = render(<Surface id={id} />);

  act(() =>
    store.addMessage(id, {
      kind: "tool_call",
      toolName: "Bash",
      toolId: "tool",
      input: "{}",
      timestamp,
    })
  );

  const slots = useChatStore.getState().sessions[id].messages;
  const before = { ...counts };

  act(() => store.addMessage(id, delta("a", "x")));

  expect(counts).toEqual(before);
  expect(useChatStore.getState().sessions[id].messages).toBe(slots);
  expect(root.container.querySelector(".evprose--plain")?.textContent).toBe(
    "xxx"
  );
});
