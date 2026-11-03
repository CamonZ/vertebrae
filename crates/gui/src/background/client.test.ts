import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createBackgroundClient } from "./client";
import type { WorkerRequest, WorkerResponse } from "./types";

class TestWorker {
  onmessage: ((event: MessageEvent<WorkerResponse>) => void) | null = null;
  onerror: (() => void) | null = null;
  onmessageerror: (() => void) | null = null;
  requests: WorkerRequest[] = [];
  terminate = vi.fn();

  postMessage(request: WorkerRequest) {
    this.requests.push(structuredClone(request));
  }

  complete() {
    const request = this.requests.at(-1)!;

    this.onmessage?.(
      new MessageEvent<WorkerResponse>("message", {
        data: {
          id: request.id,
          status: "ok",
          result: { kind: "patch", value: [] },
        },
      })
    );
  }
}

const workers: TestWorker[] = [];
let client: ReturnType<typeof createBackgroundClient>;
const task = { kind: "patch" as const, patches: ["patch"], review: false };

beforeEach(() => {
  vi.useFakeTimers();
  workers.length = 0;
  client = createBackgroundClient(() => {
    const worker = new TestWorker();
    workers.push(worker);
    return worker as unknown as Worker;
  });
});

afterEach(() => {
  client.dispose();
  vi.useRealTimers();
});

it("runs one bounded job at a time and releases its idle worker", async () => {
  const first = client.run(task);
  const second = client.run(task);

  expect(workers[0].requests).toHaveLength(1);

  workers[0].complete();
  await expect(first).resolves.toEqual([]);
  expect(workers[0].requests).toHaveLength(2);

  workers[0].complete();
  await expect(second).resolves.toEqual([]);

  vi.advanceTimersByTime(5000);
  expect(workers[0].terminate).toHaveBeenCalledOnce();
  expect(vi.getTimerCount()).toBe(0);
});

it("cancels active computation without restarting the worker", async () => {
  const controller = new AbortController();
  const first = client.run(task, controller.signal);
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });
  const second = client.run(task);

  controller.abort();
  await rejected;
  expect(workers[0].terminate).not.toHaveBeenCalled();
  expect(workers[0].requests).toHaveLength(1);

  // The retired outcome is discarded; queued work then reuses the same worker.
  workers[0].complete();
  expect(workers).toHaveLength(1);
  expect(workers[0].requests).toHaveLength(2);

  workers[0].complete();
  await expect(second).resolves.toEqual([]);
});

it("does not settle a canceled job again when its deadline or worker fails", async () => {
  const controller = new AbortController();
  const first = client.run(task, controller.signal);
  const rejected = expect(first).rejects.toMatchObject({ name: "AbortError" });

  controller.abort();
  await rejected;

  vi.advanceTimersByTime(30_000);
  expect(workers[0].terminate).toHaveBeenCalledOnce();

  const next = client.run(task);
  expect(workers).toHaveLength(2);
  workers[1].complete();
  await expect(next).resolves.toEqual([]);
});

it("cancels queued and already-aborted requests without sending them", async () => {
  const first = client.run(task);
  const controller = new AbortController();
  const queued = client.run(task, controller.signal);

  controller.abort();
  await expect(queued).rejects.toMatchObject({ name: "AbortError" });
  await expect(client.run(task, controller.signal)).rejects.toMatchObject({
    name: "AbortError",
  });

  workers[0].complete();
  await expect(first).resolves.toEqual([]);
  expect(workers[0].requests).toHaveLength(1);
});

it("queues concurrent work instead of rejecting it", async () => {
  const jobs = Array.from({ length: 40 }, () => client.run(task));

  for (let index = 0; index < jobs.length; index++) workers[0].complete();

  const settled = await Promise.allSettled(jobs);
  expect(settled.every((result) => result.status === "fulfilled")).toBe(true);
  expect(workers).toHaveLength(1);
  expect(workers[0].requests).toHaveLength(40);
});

it("rejects oversized payloads and disposes pending work", async () => {
  await expect(
    client.run({
      kind: "patch",
      patches: ["x".repeat(17 * 1024 * 1024)],
      review: false,
    })
  ).rejects.toThrow("too large");

  const jobs = Array.from({ length: 3 }, () => client.run(task));
  const settled = Promise.allSettled(jobs);
  client.dispose();
  expect((await settled).every((result) => result.status === "rejected")).toBe(
    true
  );
  expect(vi.getTimerCount()).toBe(0);
});

it("rejects deadlines and starts a fresh worker for the next request", async () => {
  const first = client.run(task);
  const rejected = expect(first).rejects.toThrow("timed out");
  const second = client.run(task);

  vi.advanceTimersByTime(30_000);
  await rejected;
  expect(workers).toHaveLength(2);
  workers[1].complete();
  await expect(second).resolves.toEqual([]);
});

it("surfaces initialization and decoding failures", async () => {
  const broken = createBackgroundClient(() => {
    throw new Error("Unavailable");
  });
  await expect(broken.run(task)).rejects.toThrow("Unavailable");
  broken.dispose();

  const result = client.run(task);

  workers[0].onmessageerror!();
  await expect(result).rejects.toThrow("could not be decoded");
});

it("lets an untimed lane run long jobs until they finish or are canceled", async () => {
  const lane = createBackgroundClient(
    () => {
      const worker = new TestWorker();
      workers.push(worker);
      return worker as unknown as Worker;
    },
    { timeoutMs: null }
  );
  const slow = lane.run(task);

  vi.advanceTimersByTime(120_000);
  expect(workers[0].terminate).not.toHaveBeenCalled();

  workers[0].complete();
  await expect(slow).resolves.toEqual([]);

  const controller = new AbortController();
  const canceled = lane.run(task, controller.signal);
  const rejected = expect(canceled).rejects.toMatchObject({
    name: "AbortError",
  });
  controller.abort();
  await rejected;
  lane.dispose();
});
