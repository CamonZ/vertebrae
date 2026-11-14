import { describe, expect, it } from "vitest";
import { compileFlowOrThrow, layoutFlow, type CompiledFlow } from "./index";
import {
  createLayoutClient,
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

  it("matches replies to requests by id, in any order", async () => {
    const fake = new FakeWorker();
    const client = createLayoutClient(() => fake);
    const first = client(flow());
    const second = client(flow());
    const [a, b] = fake.received;
    expect(a.id).not.toBe(b.id);
    fake.reply({ id: b.id, layout: { positions: { b: { x: 2, y: 0 } } } });
    fake.reply({ id: a.id, layout: { positions: { a: { x: 1, y: 0 } } } });
    expect(await first).toEqual({ positions: { a: { x: 1, y: 0 } } });
    expect(await second).toEqual({ positions: { b: { x: 2, y: 0 } } });
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
