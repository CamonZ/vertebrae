/**
 * Model-based test of the PR poller (`createPrPoller`). A Hegel state machine
 * changes the watched remotes, answers reads (each remote fine, missing one
 * PR, failing for a while, or failing until the user fixes it), lets time
 * pass, hides, shows and focuses the window and asks for explicit reads. A
 * model of each remote's retry state predicts which reads are allowed:
 *
 * - one read is in flight at a time, and each read asks once per remote;
 * - every answer is delivered once, for the requests it was read for, with
 *   the retry of each remote that failed; a PR GitHub does not find backs
 *   off nothing;
 * - a remote nobody asked for is read only while it is watched, not backing
 *   off, the window is visible and GitHub's hold-off is over, even when its
 *   request just changed; a remote only the user can fix waits for them;
 * - something watched, not waiting for the user, is read within a cadence
 *   after its backoff and the hold-off while the window is visible.
 */
import { afterEach, beforeEach, test, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type {
  GithubFailure,
  GithubPrPollBatch,
  GithubPrPollRequest,
  GithubRemotePoll,
} from "../bindings";
import { remoteKey } from "./prLinks";
import {
  PR_POLL_IDLE_MS,
  createPrPoller,
  type PrPoller,
  type PrPollAnswer,
} from "./prPoller";
import type { GithubOutcome } from "./worktreePrStore";

const HOST = "github.com";
/** Two spellings of one remote, and another remote. */
const REPOS = ["example/one", "Example/One", "example/two"];
const BASE_MS = 30_000;
const MAX_MS = 5 * 60_000;

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

type Fault = "ok" | "not_found" | "other" | "rate_limited" | "gh_missing";
/** Faults that fail the whole remote; a missing PR fails only that PR. */
type RemoteFault = Exclude<Fault, "ok" | "not_found">;

const NOT_FOUND: GithubFailure = {
  kind: "not_found",
  message: "no such PR",
  retryAfterSecs: null,
};

const FAILURES: Record<RemoteFault, GithubFailure> = {
  other: { kind: "other", message: "HTTP 502", retryAfterSecs: null },
  rate_limited: { kind: "rate_limited", message: "slow", retryAfterSecs: 90 },
  gh_missing: { kind: "gh_missing", message: "no gh", retryAfterSecs: null },
};

/** The backoff, from the poller's documented schedule, not its code. */
function delayMs(failure: GithubFailure, attempt: number) {
  if (failure.retryAfterSecs !== null)
    return Math.max(failure.retryAfterSecs * 1000, BASE_MS);
  return Math.min(BASE_MS * 2 ** (attempt - 1), MAX_MS);
}

interface Pending {
  requests: GithubPrPollRequest[];
  resolve: (outcome: GithubOutcome<GithubPrPollBatch>) => void;
}

interface Machine {
  poller: PrPoller;
  pending: Pending[];
  delivered: PrPollAnswer[];
  /** Model: watched remotes, by key, with their request as last set. */
  watched: Map<string, string>;
  /** Model: retry per remote; `null` waits for the user. */
  retry: Map<string, { attempt: number; retryAt: number | null }>;
  /** Remotes the user asked to read. */
  asked: Set<string>;
  holdOffUntil: number;
  hidden: boolean;
  violations: string[];
  log: string[];
}

const keyOf = (request: GithubPrPollRequest) =>
  remoteKey(request.host, request.repo);

const requestGen: gs.Generator<GithubPrPollRequest> = gs
  .tuples(
    gs.sampledFrom(REPOS),
    gs.arrays(gs.sampledFrom(["a", "b"]), { maxSize: 2 }),
    gs.arrays(gs.sampledFrom([1, 2]), { maxSize: 2 })
  )
  .map(([repo, branches, numbers]) => ({
    host: HOST,
    repo,
    branches,
    numbers,
  }));

const backingOff = (m: Machine, key: string, now: number) => {
  const retry = m.retry.get(key);
  return !!retry && (retry.retryAt === null || retry.retryAt > now);
};

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/**
 * Each watched remote's request, as one value per remote: the first
 * spelling of its name, and every branch and number asked for it.
 */
function merged(requests: GithubPrPollRequest[]): Map<string, string> {
  const byKey = new Map<
    string,
    { repo: string; branches: Set<string>; numbers: Set<number> }
  >();
  for (const request of requests) {
    const into = byKey.get(keyOf(request)) ?? {
      repo: request.repo,
      branches: new Set(),
      numbers: new Set(),
    };
    request.branches.forEach((branch) => into.branches.add(branch));
    request.numbers.forEach((number) => into.numbers.add(number));
    byKey.set(keyOf(request), into);
  }
  const out = new Map<string, string>();
  for (const [key, { repo, branches, numbers }] of byKey)
    if (branches.size + numbers.size > 0)
      out.set(key, JSON.stringify([repo, [...branches], [...numbers]].flat()));
  return out;
}

/** Checks a read as the poller starts it; a violation fails the next step. */
function onRead(m: Machine, requests: GithubPrPollRequest[]) {
  try {
    checkRead(m, requests);
  } catch (error) {
    m.violations.push(String(error));
  }
}

function checkRead(m: Machine, requests: GithubPrPollRequest[]) {
  const now = Date.now();
  check(m.pending.length === 0, "a second read started while one was out");
  const keys = requests.map(keyOf);
  m.log.push(`read ${keys} @${now}`);
  check(new Set(keys).size === keys.length, `a remote asked twice: ${keys}`);
  for (const request of requests) {
    const key = keyOf(request);
    if (m.asked.has(key)) {
      m.asked.delete(key);
      continue;
    }
    check(m.watched.has(key), `read ${key}, neither watched nor asked`);
    check(!m.hidden, `read ${key} while the window is hidden`);
    check(
      now >= m.holdOffUntil,
      `read ${key} ${m.holdOffUntil - now} ms inside the hold-off`
    );
    check(
      !backingOff(m, key, now),
      `read ${key} while ${JSON.stringify(m.retry.get(key))}`
    );
  }
}

function remoteAnswer(
  request: GithubPrPollRequest,
  fault: Fault
): GithubRemotePoll {
  const failure = fault === "ok" || fault === "not_found" ? null : FAILURES[fault];
  const missing = fault === "not_found";
  return {
    host: request.host,
    repo: request.repo,
    openPrs:
      request.branches.length === 0
        ? { status: "not_requested" }
        : failure
          ? { status: "failed", failure }
          : { status: "read", branches: [] },
    pullRequests: request.numbers.map((number) => ({
      number,
      result: failure
        ? { status: "failed" as const, failure }
        : missing
          ? { status: "failed" as const, failure: NOT_FOUND }
          : {
            status: "read" as const,
            pr: {
              owner: "example",
              repo: "one",
              number,
              title: "",
              state: "open" as const,
              headRef: "a",
              headRepo: null,
              baseRef: "main",
              url: "",
              author: null,
              updatedAt: null,
            },
            checks: {
              prNumber: number,
              repo: request.repo,
              headSha: "abc",
              checks: [],
              truncated: false,
            },
          },
    })),
  };
}

const faultGen = gs.sampledFrom<Fault>([
  "ok",
  "ok",
  "not_found",
  "other",
  "rate_limited",
  "gh_missing",
]);

const machine: hegel.stateful.StateMachine<Machine> = {
  rules: {
    async watch(tc, m) {
      const requests = tc.draw(gs.arrays(requestGen, { maxSize: 4 }));
      const active = tc.draw(gs.booleans());
      const next = merged(requests);
      for (const key of m.retry.keys()) if (!next.has(key)) m.retry.delete(key);
      m.watched = next;
      m.log.push(`watch ${[...next.values()]}`);
      m.poller.setWatch(requests, active);
      await flush();
    },
    async answer(tc, m) {
      const read = m.pending.shift();
      if (!read) return;
      const whole = tc.draw(
        gs.sampledFrom<"per_remote" | "other" | "gh_missing">([
          "per_remote",
          "per_remote",
          "other",
          "gh_missing",
        ])
      );
      const holdOffSecs = tc.draw(
        gs.optional(gs.integers({ minValue: 0, maxValue: 120 }))
      );
      const now = Date.now();
      const faults = read.requests.map(() =>
        whole === "per_remote" ? tc.draw(faultGen) : whole
      );
      const outcome: GithubOutcome<GithubPrPollBatch> =
        whole === "per_remote"
          ? {
              ok: true,
              data: {
                remotes: read.requests.map((request, i) =>
                  remoteAnswer(request, faults[i])
                ),
                holdOffSecs,
              },
            }
          : { ok: false, failure: FAILURES[whole] };
      m.log.push(
        `answer ${read.requests.map(keyOf)} ${whole === "per_remote" ? faults : whole} @${now}`
      );
      if (outcome.ok && holdOffSecs !== null)
        m.holdOffUntil = now + holdOffSecs * 1000;
      const expectedRetries = new Map<string, number | null>();
      read.requests.forEach((request, i) => {
        const key = keyOf(request);
        const fault = faults[i];
        if (fault === "ok" || fault === "not_found") {
          m.retry.delete(key);
          return;
        }
        const failure = FAILURES[fault];
        const attempt = (m.retry.get(key)?.attempt ?? 0) + 1;
        const retryAt =
          failure.kind === "gh_missing"
            ? null
            : Math.max(m.holdOffUntil, now + delayMs(failure, attempt));
        m.retry.set(key, { attempt, retryAt });
        expectedRetries.set(key, retryAt);
      });
      const before = m.delivered.length;
      read.resolve(outcome);
      await flush();
      check(
        m.delivered.length === before + 1,
        "an answer was not delivered once"
      );
      const answer = m.delivered[before];
      check(
        JSON.stringify(answer.requests) === JSON.stringify(read.requests),
        "an answer was delivered for other requests"
      );
      check(
        JSON.stringify([...answer.retries].map(([k, r]) => [k, r.retryAt])) ===
          JSON.stringify([...expectedRetries]),
        `retries ${JSON.stringify([...answer.retries])}, expected ${JSON.stringify([...expectedRetries])}`
      );
    },
    async wait(tc, m) {
      const ms = tc.draw(
        gs.integers({ minValue: 1, maxValue: PR_POLL_IDLE_MS })
      );
      m.log.push(`wait ${ms}`);
      await vi.advanceTimersByTimeAsync(ms);
      await flush();
    },
    async visibility(tc, m) {
      m.hidden = tc.draw(gs.booleans());
      m.log.push(m.hidden ? "hide" : "show");
      document.dispatchEvent(new Event("visibilitychange"));
      await flush();
    },
    async focus(_tc, m) {
      m.log.push("focus");
      window.dispatchEvent(new Event("focus"));
      await flush();
    },
    async ask(tc, m) {
      const requests = tc.draw(
        gs.arrays(requestGen, { minSize: 1, maxSize: 2 })
      );
      for (const key of merged(requests).keys()) m.asked.add(key);
      m.log.push(`ask ${[...merged(requests).keys()]}`);
      void m.poller.pollNow(requests);
      await flush();
    },
    async idle(_tc, m) {
      // Nothing in flight, nothing changed: a full cadence after every
      // backoff and the hold-off, a watched remote not waiting for the user
      // must have been read.
      if (m.pending.length > 0 || m.asked.size > 0 || m.hidden) return;
      const now = Date.now();
      const due = [...m.watched.keys()].filter(
        (key) => m.retry.get(key)?.retryAt !== null
      );
      if (due.length === 0) return;
      const latest = Math.max(
        m.holdOffUntil,
        ...due.map((key) => m.retry.get(key)?.retryAt ?? now)
      );
      await vi.advanceTimersByTimeAsync(
        Math.max(0, latest - now) + PR_POLL_IDLE_MS + 1
      );
      await flush();
      check(m.pending.length === 1, `${due} watched but never read`);
    },
  },
  invariants: {
    singleFlight: (_tc, m) =>
      check(m.pending.length <= 1, `${m.pending.length} reads in flight`),
    readsAllowed: (_tc, m) =>
      check(
        m.violations.length === 0,
        `${m.violations[0]}\nafter: ${m.log.join(" → ")}`
      ),
  },
};

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

test(
  "the poller reads each remote only when allowed, once at a time, and answers every read",
  () =>
    hegel.testAsync(
      async (tc) => {
        vi.setSystemTime(0);
        const m = {
          pending: [],
          delivered: [],
          watched: new Map(),
          retry: new Map(),
          asked: new Set(),
          holdOffUntil: 0,
          hidden: false,
          violations: [],
          log: [],
        } as unknown as Machine;
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => (m.hidden ? "hidden" : "visible"),
        });
        m.poller = createPrPoller({
          read: (requests) => {
            onRead(m, requests);
            return new Promise((resolve) =>
              m.pending.push({ requests, resolve })
            );
          },
          deliver: (answer) => m.delivered.push(answer),
        });
        try {
          await hegel.stateful.runAsync(tc, machine, m, { stepCount: 40 });
        } finally {
          m.poller.dispose();
          vi.clearAllTimers();
          Reflect.deleteProperty(document, "visibilityState");
        }
      },
      { testCases: 150 }
    ),
  120_000
);
