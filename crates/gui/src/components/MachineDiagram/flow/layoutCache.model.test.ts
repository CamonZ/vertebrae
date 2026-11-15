/**
 * Model-based test of the level-layout cache (`cachedLevel` in layout.ts over
 * layoutStore.ts). A Hegel state machine requests layouts by key — alone or
 * several at once — while the in-memory cache is dropped (a worker restart or
 * a cold launch), the persistent store is wiped (a new build), and the store
 * or the layout itself fails. A model of both caches predicts every outcome:
 *
 * - a request answers exactly what computing that key answers, whether it
 *   came from memory, the store or a fresh computation;
 * - a key is computed only when neither memory nor the store has it, and
 *   concurrent requests for one key share a single computation;
 * - a failed computation is not remembered: the next request computes again;
 * - a failing store degrades to computing, never to an error or a wrong
 *   layout, and a layout is stored once computed (when the store accepts it);
 * - memory is bounded (64 levels) and evicts the least recently used level:
 *   a level used since stays, so it is answered without the store.
 */
import { afterEach, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { LevelLayout } from "./compile";
import { cachedLevel, resetLayoutCache } from "./layout";
import { setLayoutStore, type LayoutStore } from "./layoutStore";

const CAPACITY = 64;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

afterEach(() => {
  setLayoutStore(undefined);
  resetLayoutCache();
});

const layoutOf = (key: string): LevelLayout => ({
  positions: { [key]: { x: key.length, y: 0 } },
});

/**
 * Stored layouts are written after the answer, once the key is hashed. Wait
 * until the store has seen every write the model expects, however long the
 * hashing takes on a busy machine.
 */
async function writesLanded(m: Machine): Promise<void> {
  for (let turns = 0; m.puts < m.expectedPuts; turns++) {
    check(turns < 10_000, `${m.expectedPuts - m.puts} store writes never came`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  check(
    m.puts === m.expectedPuts,
    `${m.puts - m.expectedPuts} unexpected store writes`
  );
}

interface Machine {
  /** Real system: the store's contents and fault switches. */
  readonly stored: Map<string, LevelLayout>;
  getFails: boolean;
  putFails: boolean;
  /** Computations run, per key. */
  readonly computed: Map<string, number>;
  /** Store writes attempted, and how many the model expects. */
  puts: number;
  expectedPuts: number;
  /** Model: keys in memory, least recently used first. */
  memory: string[];
  /** Model: keys the store holds. */
  readonly inStore: Set<string>;
}

const key = gs.oneOf(
  // A few hot keys, and enough cold ones to overflow memory.
  gs.sampledFrom(["a", "b", "c"]),
  gs.integers({ minValue: 0, maxValue: 90 }).map((n) => `level ${n}`)
);

function touch(m: Machine, k: string) {
  m.memory = m.memory.filter((x) => x !== k);
  if (m.memory.length >= CAPACITY) m.memory.shift();
  m.memory.push(k);
}

/** One request through the real cache, checked against the model. */
async function request(
  m: Machine,
  k: string,
  fail: boolean,
  copies: number,
  wait = true
) {
  const hit = m.memory.includes(k);
  const storeHit = !hit && !m.getFails && m.inStore.has(k);
  const computes = !hit && !storeHit;
  const before = m.computed.get(k) ?? 0;
  const compute = async () => {
    m.computed.set(k, (m.computed.get(k) ?? 0) + 1);
    await Promise.resolve();
    if (fail) throw new Error(`layout ${k} failed`);
    return layoutOf(k);
  };
  const results = await Promise.allSettled(
    Array.from({ length: copies }, () => cachedLevel(k, compute))
  );
  if (computes && !fail) m.expectedPuts++;
  if (wait) await writesLanded(m);
  const runs = (m.computed.get(k) ?? 0) - before;
  check(
    runs === (computes ? 1 : 0),
    `${k}: computed ${runs} times for ${copies} request(s) (memory ${hit}, store ${storeHit})`
  );
  const failed = computes && fail;
  for (const r of results) {
    if (failed) {
      check(r.status === "rejected", `${k}: a failed layout was answered`);
      continue;
    }
    check(
      r.status === "fulfilled",
      `${k}: request failed: ${String((r as PromiseRejectedResult).reason)}`
    );
    const got = (r as PromiseFulfilledResult<LevelLayout>).value;
    check(
      JSON.stringify(got) === JSON.stringify(layoutOf(k)),
      `${k}: answered ${JSON.stringify(got)}`
    );
  }
  if (failed) {
    m.memory = m.memory.filter((x) => x !== k);
    return;
  }
  touch(m, k);
  if (computes && !m.putFails) m.inStore.add(k);
}

const machine: hegel.stateful.StateMachine<Machine> = {
  rules: {
    async request(tc, m) {
      const k = tc.draw(key);
      const fail = tc.draw(gs.integers({ minValue: 0, maxValue: 5 })) === 0;
      await request(m, k, fail, 1);
    },
    async concurrent(tc, m) {
      const k = tc.draw(key);
      const copies = tc.draw(gs.integers({ minValue: 2, maxValue: 4 }));
      await request(m, k, false, copies);
    },
    async burst(tc, m) {
      // Many distinct levels in a row: an Atlas warm-up over a big project.
      const from = tc.draw(gs.integers({ minValue: 0, maxValue: 90 }));
      const count = tc.draw(gs.integers({ minValue: 8, maxValue: 70 }));
      for (let i = 0; i < count; i++)
        await request(m, `level ${from + i}`, false, 1, false);
      // Distinct keys: only the stores need to land before the next step.
      await writesLanded(m);
    },
    restart(_tc, m) {
      resetLayoutCache();
      m.memory = [];
    },
    newBuild(_tc, m) {
      m.stored.clear();
      m.inStore.clear();
    },
    storeReads(tc, m) {
      m.getFails = tc.draw(gs.booleans());
    },
    storeWrites(tc, m) {
      m.putFails = tc.draw(gs.booleans());
    },
  },
  invariants: {
    storeMatchesModel: (_tc, m) =>
      check(
        m.stored.size === m.inStore.size,
        `the store holds ${m.stored.size} layouts, the model ${m.inStore.size}`
      ),
  },
};

test(
  "cached level layouts answer like a fresh layout and compute each key only when needed",
  () =>
    hegel.testAsync(
      async (tc) => {
        resetLayoutCache();
        const stored = new Map<string, LevelLayout>();
        const m: Machine = {
          stored,
          getFails: false,
          putFails: false,
          computed: new Map(),
          puts: 0,
          expectedPuts: 0,
          memory: [],
          inStore: new Set(),
        };
        const store: LayoutStore = {
          async get(id) {
            if (m.getFails) throw new Error("store unreadable");
            return stored.get(id);
          },
          async put(id, layout) {
            m.puts++;
            if (m.putFails) throw new Error("store full");
            stored.set(id, layout);
          },
        };
        setLayoutStore(store);
        await hegel.stateful.runAsync(tc, machine, m, { stepCount: 40 });
      },
      { testCases: 80 }
    ),
  120_000
);
