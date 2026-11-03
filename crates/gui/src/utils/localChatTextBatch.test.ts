import { afterEach, expect, it, vi } from "vitest";
import type { LocalChatTextEvent } from "../bindings";
import {
  createLocalChatTextBatch,
  flushPendingLocalChatText,
} from "./localChatTextBatch";

const partial = (text: string, item_id = "a"): LocalChatTextEvent => ({
  backend_session_id: "backend",
  harness: "codex",
  turn_id: "turn",
  item_id,
  text,
  is_partial: true,
  parent_tool_use_id: null,
});

afterEach(() => vi.useRealTimers());

it("publishes at a bounded cadence and preserves repeated segments, ordering and final snapshots", () => {
  vi.useFakeTimers();

  const publish = vi.fn();
  const batch = createLocalChatTextBatch(publish);

  batch.push(partial("x"));
  batch.push(partial("x"));
  batch.push(partial("b", "b"));
  batch.push(partial("z"));

  expect(publish).not.toHaveBeenCalled();

  vi.advanceTimersByTime(32);

  expect(publish.mock.calls.map(([e]) => [e.item_id, e.text])).toEqual([
    ["a", "xx"],
    ["b", "b"],
    ["a", "z"],
  ]);

  batch.push(partial(" pending"));
  batch.push({ ...partial("authoritative"), is_partial: false });

  expect(publish.mock.calls.slice(-2).map(([e]) => e.text)).toEqual([
    " pending",
    "authoritative",
  ]);

  batch.dispose();

  expect(vi.getTimerCount()).toBe(0);
});

it("bounds pending events and characters without dropping oversized payloads", () => {
  vi.useFakeTimers();

  const publish = vi.fn();
  const batch = createLocalChatTextBatch(publish);

  for (let i = 0; i < 300; i++) batch.push(partial("x"));
  batch.push(partial("y".repeat(65536)));
  batch.dispose();

  expect(publish.mock.calls.map(([e]) => e.text).join("")).toBe(
    "x".repeat(300) + "y".repeat(65536)
  );

  expect(vi.getTimerCount()).toBe(0);
});

it("flushes before local cancellation and disposes on teardown", () => {
  vi.useFakeTimers();

  const publish = vi.fn();
  const batch = createLocalChatTextBatch(publish);

  batch.push(partial("received"));
  flushPendingLocalChatText();

  expect(publish).toHaveBeenCalledExactlyOnceWith(partial("received"));

  batch.push(partial("last"));
  batch.dispose();

  expect(publish).toHaveBeenCalledTimes(2);

  batch.push(partial("retired callback"));

  expect(publish).toHaveBeenCalledTimes(2);
  expect(vi.getTimerCount()).toBe(0);
});
