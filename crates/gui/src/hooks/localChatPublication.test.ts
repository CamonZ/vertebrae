import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import {
  useLocalChatEventRouter,
  resetLocalChatTurnRoutingForTests,
} from "./useLocalChatEventRouter";
import { useChatStore } from "../stores/chatStore";
import { materializeLiveAssistantMessages } from "../stores/liveAssistantMessages";

const handlers = vi.hoisted(
  () => new Map<string, (event: { payload: unknown }) => void>()
);

vi.mock("@tauri-apps/api/event", () => ({
  listen: vi.fn(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, handler);
      return () => handlers.delete(name);
    }
  ),
}));

const emit = (name: string, payload: unknown) =>
  handlers.get(`local-chat-${name}-event`)!({ payload });

const scope = {
  backend_session_id: "backend",
  harness: "codex",
  turn_id: "turn",
  is_root: true,
  thread_id: "thread",
};

afterEach(() => {
  useChatStore.getState().reset();
  resetLocalChatTurnRoutingForTests();
  vi.useRealTimers();
});

it("flushes real subscription callbacks before tools, cancellation, terminal events and teardown", async () => {
  const store = useChatStore.getState();
  const id = store.openSession("Publication");
  store.setBackendSessionId(id, "backend");
  store.beginActiveTurn(id);

  const root = renderHook(useLocalChatEventRouter);

  await act(async () => {
    await Promise.resolve();
  });

  vi.useFakeTimers();
  act(() => emit("turn-started", scope));

  const text = (value: string, item_id = "a") =>
    emit("text", {
      ...scope,
      item_id,
      parent_tool_use_id: null,
      text: value,
      is_partial: true,
    });

  act(() => {
    text("x");
    text("x");
  });

  expect(useChatStore.getState().sessions[id].messages).toEqual([]);

  act(() =>
    emit("tool-call", {
      ...scope,
      tool_id: "tool",
      tool_name: "Bash",
      input: "{}",
      parent_tool_use_id: null,
    })
  );

  expect(useChatStore.getState().sessions[id].messages).toEqual([
    expect.objectContaining({ text: "xx", itemId: "a" }),
    expect.objectContaining({ toolId: "tool" }),
  ]);

  act(() => {
    text("b", "b");
    text("a");
    store.markActiveTurnStopping(id);
  });

  expect(
    materializeLiveAssistantMessages(useChatStore.getState().sessions[id])
      .messages
  ).toEqual([
    expect.objectContaining({ text: "xxa" }),
    expect.objectContaining({ toolId: "tool" }),
    expect.objectContaining({ text: "b" }),
  ]);

  act(() => {
    text("last", "b");
    store.interruptStreamingAssistant(id, "turn");
  });

  expect(useChatStore.getState().sessions[id].messages.at(-1)).toMatchObject({
    text: "blast",
    lifecycle: "interrupted",
  });

  act(() => text("late", "a"));
  act(() => emit("session-error", { ...scope, error: "failed" }));

  expect(
    useChatStore
      .getState()
      .sessions[id].messages.filter((m) => m.kind === "assistant")
  ).toHaveLength(2);

  root.unmount();

  expect(vi.getTimerCount()).toBe(0);
});

it("retires queued text when the backend session is replaced", async () => {
  const store = useChatStore.getState();
  const id = store.openSession("Replaced");
  store.setBackendSessionId(id, "backend");
  store.beginActiveTurn(id);

  const root = renderHook(useLocalChatEventRouter);

  await act(async () => {
    await Promise.resolve();
  });

  vi.useFakeTimers();
  act(() => emit("turn-started", scope));
  act(() =>
    emit("text", {
      ...scope,
      item_id: "a",
      text: "retired",
      is_partial: true,
      parent_tool_use_id: null,
    })
  );
  act(() => store.setBackendSessionId(id, "replacement"));
  act(() => vi.advanceTimersByTime(32));

  expect(useChatStore.getState().sessions[id].messages).toEqual([]);

  root.unmount();

  expect(vi.getTimerCount()).toBe(0);
});
