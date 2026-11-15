import { describe, expect, it } from "vitest";
import { compileFlowOrThrow, layoutFlow, type CompiledFlow } from "./index";
import {
  createLayoutClient,
  LayoutAbortedError,
  type LayoutRequest,
  type LayoutResponse,
  type LayoutWorker,
} from "./layoutClient";

const flow = (): CompiledFlow =>
  compileFlowOrThrow({
    version: 1,
    parts: [
      { id: "a", kind: "worker" },
      { id: "b", kind: "store" },
    ],
    rails: [{ id: "r", from: "b.out", to: "a.in" }],
  });

/** A worker that answers on demand, so tests control reply order and failure. */
class FakeWorker implements LayoutWorker {
  onmessage: ((event: MessageEvent<LayoutResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly received: LayoutRequest[] = [];
  terminated = false;
  postMessage(message: LayoutRequest) {
    this.received.push(message);
  }
  terminate() {
    this.terminated = true;
  }
  reply(data: LayoutResponse) {
    this.onmessage?.({ data } as MessageEvent<LayoutResponse>);
  }
  crash(message: string) {
    this.onerror?.({ message } as ErrorEvent);
  }
}

describe("layout client", () => {
  it("lays out on the calling thread without workers", async () => {
    const f = flow();
    const layout = await createLayoutClient(undefined)(f);
    expect(layout).toEqual(await layoutFlow(f, { cache: false }));
  });

  it("falls back to the calling thread when the worker cannot start", async () => {
    const f = flow();
    const client = createLayoutClient(() => {
      throw new Error("no workers here");
    });
    expect(await client(f)).toEqual(await layoutFlow(f, { cache: false }));
  });

  it("sends one request at a time and ignores replies for other ids", async () => {
    const fake = new FakeWorker();
    const client = createLayoutClient(() => fake);
    const first = client(flow());
    const second = client(flow());
    expect(fake.received).toHaveLength(1);
    const [a] = fake.received;
    fake.reply({ id: a.id + 1, layout: { positions: {} } });
    fake.reply({ id: a.id, layout: { positions: { a: { x: 1, y: 0 } } } });
    expect(await first).toEqual({ positions: { a: { x: 1, y: 0 } } });
    expect(fake.received).toHaveLength(2);
    const b = fake.received[1];
    expect(b.id).not.toBe(a.id);
    fake.reply({ id: b.id, layout: { positions: { b: { x: 2, y: 0 } } } });
    expect(await second).toEqual({ positions: { b: { x: 2, y: 0 } } });
  });

  it("drops an aborted queued request without disturbing the worker", async () => {
    const fake = new FakeWorker();
    const client = createLayoutClient(() => fake);
    const first = client(flow());
    const abort = new AbortController();
    const second = client(flow(), { signal: abort.signal });
    abort.abort();
    await expect(second).rejects.toBeInstanceOf(LayoutAbortedError);
    expect(fake.terminated).toBe(false);
    fake.reply({ id: fake.received[0].id, layout: { positions: {} } });
    expect(await first).toEqual({ positions: {} });
    expect(fake.received).toHaveLength(1);
  });

  it("restarts the worker when the request in flight is aborted", async () => {
    const workers: FakeWorker[] = [];
    const client = createLayoutClient(() => {
      workers.push(new FakeWorker());
      return workers.at(-1)!;
    });
    const abort = new AbortController();
    const slow = client(flow(), { signal: abort.signal });
    const queued = client(flow());
    abort.abort();
    await expect(slow).rejects.toBeInstanceOf(LayoutAbortedError);
    expect(workers[0].terminated).toBe(true);
    expect(workers).toHaveLength(2);
    // A late reply from the abandoned worker resolves nothing.
    workers[0].reply({
      id: workers[0].received[0].id,
      layout: { positions: {} },
    });
    workers[1].reply({
      id: workers[1].received[0].id,
      layout: { positions: { q: { x: 3, y: 0 } } },
    });
    expect(await queued).toEqual({ positions: { q: { x: 3, y: 0 } } });
  });

  it("reports when a queued request actually starts", async () => {
    const fake = new FakeWorker();
    const client = createLayoutClient(() => fake);
    const started: string[] = [];
    const first = client(flow(), { onStart: () => started.push("first") });
    void client(flow(), { onStart: () => started.push("second") });
    expect(started).toEqual(["first"]);
    fake.reply({ id: fake.received[0].id, layout: { positions: {} } });
    await first;
    expect(started).toEqual(["first", "second"]);
  });

  it("rejects immediately when the signal is already aborted", async () => {
    const fake = new FakeWorker();
    const abort = new AbortController();
    abort.abort();
    await expect(
      createLayoutClient(() => fake)(flow(), { signal: abort.signal })
    ).rejects.toBeInstanceOf(LayoutAbortedError);
    expect(fake.received).toHaveLength(0);
  });

  it("rejects with the worker's layout error", async () => {
    const fake = new FakeWorker();
    const pending = createLayoutClient(() => fake)(flow());
    fake.reply({ id: fake.received[0].id, error: "boom" });
    await expect(pending).rejects.toThrow("boom");
  });

  it("fails requests in flight when the worker crashes, then starts a new one", async () => {
    const workers: FakeWorker[] = [];
    const client = createLayoutClient(() => {
      workers.push(new FakeWorker());
      return workers.at(-1)!;
    });
    const lost = client(flow());
    workers[0].crash("worker died");
    await expect(lost).rejects.toThrow("worker died");
    expect(workers[0].terminated).toBe(true);
    const next = client(flow());
    expect(workers).toHaveLength(2);
    workers[1].reply({
      id: workers[1].received[0].id,
      layout: { positions: {} },
    });
    expect(await next).toEqual({ positions: {} });
  });
});

describe("layout client priority", () => {
  it("serves visible requests before queued background ones", async () => {
    const fake = new FakeWorker();
    const client = createLayoutClient(() => fake);
    const order: string[] = [];
    const track = (name: string, p: Promise<unknown>) =>
      p.then(() => order.push(name));
    const running = track("running", client(flow()));
    const warm = track("warm", client(flow(), { priority: "background" }));
    const visible = track("visible", client(flow()));
    for (let i = 0; i < 3; i++) {
      const at = fake.received[i];
      fake.reply({ id: at.id, layout: { positions: {} } });
      await Promise.resolve();
    }
    await Promise.all([running, warm, visible]);
    expect(order).toEqual(["running", "visible", "warm"]);
  });

  it("asks the worker for a composite layout when requested", () => {
    const fake = new FakeWorker();
    const client = createLayoutClient(() => fake);
    void client(flow(), { composite: true });
    expect(fake.received[0].composite).toBe(true);
  });
});
