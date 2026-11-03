import { waitFor } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { commands } from "../bindings";
import { useChatStore, type ChatMessage } from "./chatStore";
import { prepareProviderReplay } from "./prepareProviderReplay";
import { materializeLiveAssistantMessages } from "./liveAssistantMessages";
import type { BackgroundOutputs, BackgroundTask } from "../background/types";

const jobs = vi.hoisted(
  () =>
    [] as Array<{
      task: Extract<BackgroundTask, { kind: "replay" }>;
      signal?: AbortSignal;
      resolve(value: BackgroundOutputs["replay"]): void;
      reject(error: Error): void;
    }>
);
vi.mock("../background/client", () => ({
  replayClient: {
    run: vi.fn(
      (task: BackgroundTask, signal?: AbortSignal) =>
        new Promise<BackgroundOutputs["replay"]>((resolve, reject) => {
          if (task.kind !== "replay") throw new Error("Unexpected job");

          jobs.push({ task, signal, resolve, reject });
          signal?.addEventListener(
            "abort",
            () => reject(new DOMException("Canceled", "AbortError")),
            { once: true }
          );
        })
    ),
  },
}));

const timestamp = "2026-11-03T12:00:00Z";
const line = (id: string, sequence: number) =>
  JSON.stringify({
    version: 1,
    event_id: id,
    stream_id: "s",
    sequence,
    correlation: { item_id: id, turn_id: "turn" },
    timestamp,
    type: "text",
    semantics: "snapshot",
    data: { text: id, completion_status: "completed" },
  });
const partial = (
  text: string
): Extract<ChatMessage, { kind: "assistant" }> => ({
  kind: "assistant",
  itemId: "live",
  turnId: "turn",
  text,
  timestamp,
  isPartial: true,
  lifecycle: "streaming",
});
const finish = (index: number) =>
  jobs[index].resolve(prepareProviderReplay(jobs[index].task.input));

beforeEach(() => {
  vi.stubGlobal("Worker", class {});
  jobs.length = 0;
  localStorage.clear();
});

afterEach(async () => {
  useChatStore.getState().reset();
  await Promise.resolve();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function open(hasOlder = false) {
  vi.spyOn(commands, "loadLocalChatSessionReplay").mockResolvedValue({
    status: "ok",
    data: {
      events: [line("history", 1)],
      cache_key: "revision",
      next_cursor: hasOlder ? "older" : null,
      has_more: hasOlder,
    },
  });

  const id = (await useChatStore.getState().selectProviderThreadSession({
    harness: "codex",
    providerResumeId: "thread",
  }))!;
  await waitFor(() => expect(jobs).toHaveLength(1));
  return id;
}

it("rebases semantic races onto the latest transcript without re-running the projection", async () => {
  const id = await open();
  const store = useChatStore.getState();

  store.addMessage(id, partial("received"));
  store.addMessage(id, {
    kind: "tool_call",
    toolId: "tool",
    toolName: "Bash",
    input: "{}",
    timestamp,
  });
  finish(0);
  await waitFor(() =>
    expect(useChatStore.getState().sessions[id].providerReplay?.loaded).toBe(
      true
    )
  );
  store.addMessage(id, partial(" exactly"));
  const messages = materializeLiveAssistantMessages(
    useChatStore.getState().sessions[id]
  ).messages;

  expect(jobs).toHaveLength(1);
  expect(messages).toMatchObject([
    { text: "history" },
    { itemId: "live", text: "received exactly", lifecycle: "streaming" },
    { toolId: "tool" },
  ]);
});

it("never installs a canceled result into a cleared or replaced session", async () => {
  const id = await open();

  useChatStore.getState().clearMessages(id);
  expect(jobs[0].signal?.aborted).toBe(true);
  finish(0);
  await Promise.resolve();
  await Promise.resolve();
  expect(useChatStore.getState().sessions[id].messages).toEqual([]);
  expect(useChatStore.getState().sessions[id].providerReplay).toBeUndefined();
});

it("keeps newer terminal text when a replay computation completes late", async () => {
  const id = await open();
  const store = useChatStore.getState();

  store.addMessage(id, partial("stream"));
  store.addMessage(id, {
    ...partial("authoritative"),
    lifecycle: "completed",
    isPartial: false,
  });
  finish(0);
  await waitFor(() =>
    expect(useChatStore.getState().sessions[id].providerReplay?.loaded).toBe(
      true
    )
  );
  expect(jobs).toHaveLength(1);
  expect(useChatStore.getState().sessions[id].messages.at(-1)).toMatchObject({
    text: "authoritative",
    lifecycle: "completed",
  });
});

it("prepares older pages off-thread and preserves tools arriving during pagination", async () => {
  const id = await open(true);
  finish(0);
  await waitFor(() =>
    expect(useChatStore.getState().sessions[id].providerReplay?.loaded).toBe(
      true
    )
  );
  vi.mocked(commands.loadLocalChatSessionReplay).mockResolvedValueOnce({
    status: "ok",
    data: {
      events: [line("older", 0)],
      cache_key: "revision",
      next_cursor: null,
      has_more: false,
    },
  });

  const request = useChatStore.getState().loadOlderReplayMessages(id);
  await waitFor(() => expect(jobs).toHaveLength(2));
  useChatStore.getState().addMessage(id, {
    kind: "tool_call",
    toolId: "tool",
    toolName: "Bash",
    input: "{}",
    timestamp,
  });
  finish(1);
  await expect(request).resolves.toBe(true);
  expect(jobs).toHaveLength(2);
  expect(useChatStore.getState().sessions[id].messages).toMatchObject([
    { text: "older" },
    { text: "history" },
    { toolId: "tool" },
  ]);
});

it("surfaces worker failures without replacing the transcript", async () => {
  const id = await open();

  useChatStore.getState().addMessage(id, partial("keep this"));
  jobs[0].reject(new Error("worker failed"));
  await waitFor(() =>
    expect(useChatStore.getState().sessions[id].providerReplay?.error).toBe(
      "worker failed"
    )
  );
  expect(useChatStore.getState().sessions[id].messages[0]).toMatchObject({
    text: "keep this",
  });
});

it("retires a background refresh when pagination installs a newer baseline", async () => {
  const id = await open(true);
  finish(0);
  await waitFor(() =>
    expect(useChatStore.getState().sessions[id].providerReplay?.loaded).toBe(
      true
    )
  );
  let resolveRefresh!: (
    value: Awaited<ReturnType<typeof commands.loadLocalChatSessionReplay>>
  ) => void;
  vi.mocked(commands.loadLocalChatSessionReplay)
    .mockReturnValueOnce(
      new Promise((resolve) => {
        resolveRefresh = resolve;
      })
    )
    .mockResolvedValueOnce({
      status: "ok",
      data: {
        events: [line("older", 0)],
        cache_key: "revision",
        next_cursor: null,
        has_more: false,
      },
    });

  useChatStore.getState().refreshProviderThreadSession(id);
  const pagination = useChatStore.getState().loadOlderReplayMessages(id);
  await waitFor(() => expect(jobs).toHaveLength(2));
  finish(1);
  await expect(pagination).resolves.toBe(true);

  resolveRefresh({
    status: "ok",
    data: {
      events: [line("history", 1)],
      cache_key: "new-revision",
      next_cursor: null,
      has_more: false,
    },
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(jobs).toHaveLength(2);
  expect(useChatStore.getState().sessions[id].messages).toMatchObject([
    { text: "older" },
    { text: "history" },
  ]);
  expect(useChatStore.getState().sessions[id].providerReplay?.cacheKey).toBe(
    "revision"
  );
});
