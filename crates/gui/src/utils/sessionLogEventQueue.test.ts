import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { SessionLog } from "../bindings";
import {
  createSessionLogEventQueue,
  isUrgentSessionLog,
} from "./sessionLogEventQueue";

function createEvent(
  id: string,
  overrides: Partial<SessionLog> = {}
) {
  return {
    executionId: "exec-1",
    log: {
      id,
      step_execution_id: "exec-1",
      content: `log ${id}`,
      created_at: "2026-03-17T10:00:00Z",
      ...overrides,
    },
    operation: "append" as const,
    urgent: false,
  };
}

function flushedIds(events: readonly { log: Pick<SessionLog, "id"> }[]) {
  return events.map(({ log }) => log.id ?? "");
}

describe("SessionLogEventQueue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("batches events on a frame and respects the bounded batch size", () => {
    const frameCallbacks: Array<() => void> = [];
    const flushed: string[][] = [];
    const queue = createSessionLogEventQueue({
      maxBatchSize: 2,
      requestAnimationFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame: vi.fn(),
      onFlush: (events) => flushed.push(flushedIds(events)),
    });

    queue.enqueue(createEvent("log-1"));
    queue.enqueue(createEvent("log-2"));
    queue.enqueue(createEvent("log-3"));

    expect(flushed).toEqual([]);
    expect(queue.pendingCount).toBe(3);
    expect(frameCallbacks).toHaveLength(1);

    frameCallbacks[0]();
    expect(flushed).toEqual([["log-1", "log-2"]]);
    expect(queue.pendingCount).toBe(1);
    expect(frameCallbacks).toHaveLength(2);

    frameCallbacks[1]();
    expect(flushed).toEqual([["log-1", "log-2"], ["log-3"]]);
    expect(queue.pendingCount).toBe(0);
    queue.dispose({ flush: false });
  });

  it("flushes by the maximum interval when a frame callback is delayed", () => {
    const flushed: string[][] = [];
    const queue = createSessionLogEventQueue({
      requestAnimationFrame: () => 1,
      cancelAnimationFrame: vi.fn(),
      onFlush: (events) => flushed.push(flushedIds(events)),
    });

    queue.enqueue(createEvent("log-1"));
    vi.advanceTimersByTime(49);
    expect(flushed).toEqual([]);

    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([["log-1"]]);
    queue.dispose({ flush: false });
  });

  it("flushes terminal events promptly and keeps earlier events ordered", () => {
    const flushed: string[][] = [];
    const queue = createSessionLogEventQueue({
      requestAnimationFrame: undefined,
      onFlush: (events) => flushed.push(flushedIds(events)),
    });

    queue.enqueue(createEvent("delta"));
    queue.enqueue({
      ...createEvent("terminal", {
        content: '{"type":"run_finished","cost":12}',
      }),
      urgent: true,
    });

    vi.advanceTimersByTime(15);
    expect(flushed).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(flushed).toEqual([["delta", "terminal"]]);
    queue.dispose({ flush: false });
  });

  it("forces an overflow flush without dropping the overflowing event", () => {
    const flushed: string[][] = [];
    const onOverflow = vi.fn();
    const queue = createSessionLogEventQueue({
      requestAnimationFrame: undefined,
      maxPendingRecords: 2,
      onOverflow,
      onFlush: (events) => flushed.push(flushedIds(events)),
    });

    queue.enqueue(createEvent("log-1"));
    queue.enqueue(createEvent("log-2"));
    queue.enqueue(createEvent("log-3"));

    expect(onOverflow).toHaveBeenCalledOnce();
    expect(flushed).toEqual([["log-1", "log-2"]]);
    expect(queue.pendingCount).toBe(1);

    vi.advanceTimersByTime(50);
    expect(flushed).toEqual([["log-1", "log-2"], ["log-3"]]);
    queue.dispose({ flush: false });
  });

  it("retains a failed batch for a later retry", () => {
    const flushed: string[][] = [];
    let attempts = 0;
    const frameCallbacks: Array<() => void> = [];
    const queue = createSessionLogEventQueue({
      requestAnimationFrame: (callback) => {
        frameCallbacks.push(callback);
        return frameCallbacks.length;
      },
      cancelAnimationFrame: vi.fn(),
      onFlush: (events) => {
        attempts += 1;
        if (attempts === 1) throw new Error("store unavailable");
        flushed.push(flushedIds(events));
      },
    });

    queue.enqueue(createEvent("log-1"));
    expect(() => frameCallbacks[0]()).toThrow("store unavailable");
    expect(queue.pendingCount).toBe(1);

    frameCallbacks[1]();
    expect(flushed).toEqual([["log-1"]]);
    expect(queue.pendingCount).toBe(0);
    queue.dispose({ flush: false });
  });

  it("cancels scheduled work when disposed without flushing", () => {
    const onFlush = vi.fn();
    const queue = createSessionLogEventQueue({
      requestAnimationFrame: undefined,
      onFlush,
    });

    queue.enqueue(createEvent("log-1"));
    queue.dispose({ flush: false });
    vi.advanceTimersByTime(50);

    expect(onFlush).not.toHaveBeenCalled();
    expect(queue.enqueue(createEvent("log-2"))).toBe(false);
  });
});

describe("isUrgentSessionLog", () => {
  it.each([
    '{"type":"run_finished"}',
    '{ "event_type": "turn_finished" }',
    '{"type":"error","message":"failed"}',
  ])("recognizes terminal payload %s", (content) => {
    expect(
      isUrgentSessionLog({
        id: "terminal",
        step_execution_id: "exec-1",
        content,
        created_at: "2026-03-17T10:00:00Z",
      })
    ).toBe(true);
  });

  it("does not classify ordinary deltas as urgent", () => {
    expect(
      isUrgentSessionLog({
        id: "delta",
        step_execution_id: "exec-1",
        content: '{"type":"assistant_delta","content":"hello"}',
        created_at: "2026-03-17T10:00:00Z",
      })
    ).toBe(false);
  });
});
