/**
 * Model-based test of the serial layout client (layoutClient.ts). A Hegel
 * state machine submits visible and background requests (some already
 * aborted), abandons queued and running ones, and makes the worker answer,
 * fail, send stale replies or crash. A model of the queue predicts what the
 * client must do, and after every step the client must agree:
 *
 * - the worker holds at most one request, and it is the one the model
 *   predicts: the oldest waiting visible request, else the oldest background
 *   one (FIFO within a priority);
 * - every request settles exactly once, with its own layout, the worker's
 *   error, or an abort — never another request's answer;
 * - `onStart` fires once for a request that reaches the worker, before it
 *   settles, and never for one abandoned while queued or already aborted;
 * - abandoning a queued request leaves the worker alone; abandoning the
 *   running one, or a crash, retires that worker and the next request starts
 *   on a fresh one; a retired worker is never sent anything again;
 * - nothing waits while the worker is idle, and once the worker answers
 *   everything, every request has settled.
 */
import { expect, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { CompiledFlow, FlowLayout } from "./index";
import {
  createLayoutClient,
  LayoutAbortedError,
  type LayoutRequest,
  type LayoutResponse,
  type LayoutWorker,
} from "./layoutClient";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

class FakeWorker implements LayoutWorker {
  onmessage: ((event: MessageEvent<LayoutResponse>) => void) | null = null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  readonly received: LayoutRequest[] = [];
  terminated = false;
  postMessage(message: LayoutRequest) {
    check(!this.terminated, "a retired worker was sent a request");
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

type Outcome =
  | { kind: "layout"; layout: FlowLayout }
  | { kind: "aborted" }
  | { kind: "error"; message: string };

interface Request {
  /** Submission order, used as the request's identity in the model. */
  readonly n: number;
  readonly flow: CompiledFlow;
  readonly background: boolean;
  readonly abort: AbortController;
  /** Times onStart fired, and whether the request had settled by then. */
  starts: number;
  startedAfterSettling: boolean;
  /** Every settlement the client delivered. */
  outcomes: Outcome[];
  /** What the model says the outcome must be, once settled. */
  expected?: Outcome;
  /** Worker message id, once the request was posted. */
  id?: number;
}

interface Machine {
  readonly client: ReturnType<typeof createLayoutClient>;
  readonly workers: FakeWorker[];
  readonly requests: Request[];
  /** Model: requests waiting, in submission order. */
  queue: Request[];
  /** Model: the request on the worker. */
  running: Request | undefined;
}

const worker = (m: Machine) => m.workers[m.workers.length - 1];
const flush = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};
const layoutFor = (n: number) =>
  ({ positions: {}, n }) as unknown as FlowLayout;

/** The model's choice of the next request to start, removed from the queue. */
function nextUp(m: Machine): Request | undefined {
  const at = m.queue.findIndex((r) => !r.background);
  const [next] = m.queue.splice(at >= 0 ? at : 0, 1);
  return next;
}

/** After the worker frees up, the model starts the next request. */
function advance(m: Machine) {
  if (m.running) return;
  const next = nextUp(m);
  if (!next) return;
  m.running = next;
}

function settle(r: Request, expected: Outcome) {
  r.expected = expected;
}

const machine: hegel.stateful.StateMachine<Machine> = {
  rules: {
    async submit(tc, m) {
      const background = tc.draw(gs.booleans());
      const preAborted =
        tc.draw(gs.integers({ minValue: 0, maxValue: 9 })) === 0;
      const abort = new AbortController();
      if (preAborted) abort.abort();
      // A distinct object per request: the worker reply must reach this one.
      const flow = {
        arrangements: [],
        n: m.requests.length,
      } as unknown as CompiledFlow;
      const r: Request = {
        n: m.requests.length,
        flow,
        background,
        abort,
        starts: 0,
        startedAfterSettling: false,
        outcomes: [],
      };
      m.requests.push(r);
      m.client(flow, {
        signal: abort.signal,
        priority: background ? "background" : "visible",
        onStart: () => {
          r.starts++;
          if (r.outcomes.length) r.startedAfterSettling = true;
        },
      }).then(
        (layout) => r.outcomes.push({ kind: "layout", layout }),
        (error: unknown) =>
          r.outcomes.push(
            error instanceof LayoutAbortedError
              ? { kind: "aborted" }
              : { kind: "error", message: (error as Error).message }
          )
      );
      if (preAborted) settle(r, { kind: "aborted" });
      else {
        m.queue.push(r);
        advance(m);
      }
      await flush();
    },
    async abandonQueued(tc, m) {
      tc.assume(m.queue.length > 0);
      const at = tc.draw(
        gs.integers({ minValue: 0, maxValue: m.queue.length - 1 })
      );
      const [r] = m.queue.splice(at, 1);
      const w = worker(m);
      const sentBefore = w?.received.length ?? 0;
      r.abort.abort();
      settle(r, { kind: "aborted" });
      await flush();
      check(
        !w || (!w.terminated && w.received.length === sentBefore),
        "abandoning a queued request disturbed the worker"
      );
    },
    async abandonRunning(tc, m) {
      tc.assume(m.running !== undefined);
      const r = m.running!;
      const w = worker(m);
      r.abort.abort();
      settle(r, { kind: "aborted" });
      check(w.terminated, "abandoning the running request kept its worker");
      m.running = undefined;
      advance(m);
      await flush();
    },
    async answer(tc, m) {
      tc.assume(m.running !== undefined);
      const r = m.running!;
      const fails = tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0;
      worker(m).reply(
        fails
          ? { id: r.id!, error: `layout ${r.n} failed` }
          : { id: r.id!, layout: layoutFor(r.n) }
      );
      settle(
        r,
        fails
          ? { kind: "error", message: `layout ${r.n} failed` }
          : { kind: "layout", layout: layoutFor(r.n) }
      );
      m.running = undefined;
      advance(m);
      await flush();
    },
    async staleReply(tc, m) {
      const w = worker(m);
      tc.assume(w !== undefined);
      // An id the worker is not working on: an earlier request's, or unknown.
      const ids = m.requests
        .map((r) => r.id)
        .filter((id): id is number => id !== undefined && id !== m.running?.id);
      const id = tc.draw(
        gs.oneOf(gs.just(-1), ...(ids.length ? [gs.sampledFrom(ids)] : []))
      );
      w.reply({ id, layout: layoutFor(-1) });
      await flush();
    },
    async crash(tc, m) {
      const w = worker(m);
      tc.assume(w !== undefined && !w.terminated);
      const r = m.running;
      w.crash("worker crashed");
      check(w.terminated, "a crashed worker was kept");
      if (r) settle(r, { kind: "error", message: "worker crashed" });
      m.running = undefined;
      advance(m);
      await flush();
    },
  },
  invariants: {
    agreesWithModel: { alwaysCheck: true, check: (_tc, m) => agrees(m) },
  },
};

function agrees(m: Machine): void {
  const w = worker(m);
  // The running request is the last thing the live worker was sent.
  if (m.running) {
    check(w !== undefined && !w.terminated, "a request runs on no live worker");
    const last = w.received[w.received.length - 1];
    check(
      last?.flow === m.running.flow,
      `the worker runs ${JSON.stringify(last?.flow)}, the model expects request ${m.running.n}`
    );
    m.running.id = last.id;
  } else {
    check(m.queue.length === 0, "requests wait while the worker is idle");
  }
  // Retired workers got nothing after retirement (FakeWorker throws),
  // and only the newest worker may be live.
  for (const old of m.workers.slice(0, -1))
    check(old.terminated, "an older worker was left running");
  // Messages carry each request once.
  const sent = m.workers.flatMap((x) => x.received.map((q) => q.flow));
  check(new Set(sent).size === sent.length, "a request was sent twice");
  for (const r of m.requests) {
    check(r.outcomes.length <= 1, `request ${r.n} settled twice`);
    const waiting = m.queue.includes(r) || m.running === r;
    if (waiting)
      check(r.outcomes.length === 0, `request ${r.n} settled while waiting`);
    if (r.expected) {
      check(r.outcomes.length === 1, `request ${r.n} has not settled`);
      const got = r.outcomes[0];
      check(
        JSON.stringify(got) === JSON.stringify(r.expected),
        `request ${r.n}: expected ${JSON.stringify(r.expected)}, got ${JSON.stringify(got)}`
      );
    }
    const reached = sent.includes(r.flow);
    check(
      r.starts === (reached ? 1 : 0),
      `request ${r.n} started ${r.starts} times (reached the worker: ${reached})`
    );
    check(!r.startedAfterSettling, `request ${r.n} started after settling`);
  }
}

test("the layout client serves one request at a time, in priority order, and settles each once", () =>
  hegel.testAsync(
    async (tc) => {
      const workers: FakeWorker[] = [];
      const m: Machine = {
        client: createLayoutClient(() => {
          const w = new FakeWorker();
          workers.push(w);
          return w;
        }),
        workers,
        requests: [],
        queue: [],
        running: undefined,
      };
      await hegel.stateful.runAsync(tc, machine, m, { stepCount: 30 });
      // Liveness: answering whatever runs drains the queue.
      while (m.running) {
        const r = m.running;
        worker(m).reply({ id: r.id!, layout: layoutFor(r.n) });
        settle(r, { kind: "layout", layout: layoutFor(r.n) });
        m.running = undefined;
        advance(m);
        await flush();
        agrees(m);
      }
      for (const r of m.requests)
        check(r.outcomes.length === 1, `request ${r.n} never settled`);
    },
    { testCases: 200 }
  ));

test("model sanity: background requests wait behind visible ones", async () => {
  const workers: FakeWorker[] = [];
  const client = createLayoutClient(() => {
    const w = new FakeWorker();
    workers.push(w);
    return w;
  });
  const flows = [0, 1, 2].map((n) => ({ n }) as unknown as CompiledFlow);
  void client(flows[0], { priority: "background" }).catch(() => undefined);
  void client(flows[1], { priority: "background" }).catch(() => undefined);
  void client(flows[2]).catch(() => undefined);
  workers[0].reply({ id: workers[0].received[0].id, layout: layoutFor(0) });
  await flush();
  expect(workers[0].received.map((q) => q.flow)).toEqual([flows[0], flows[2]]);
});
