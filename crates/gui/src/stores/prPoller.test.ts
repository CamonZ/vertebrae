import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { GithubPrPollBatch, GithubPrPollRequest } from "../bindings";
import { remoteKey } from "./prLinks";
import { createPrPoller, mergeRequests } from "./prPoller";
import type { GithubOutcome } from "./worktreePrStore";

const REQUEST: GithubPrPollRequest = {
  host: "github.com",
  repo: "example/one",
  branches: [],
  numbers: [1],
};

type Outcome = GithubOutcome<GithubPrPollBatch>;

const failed: Outcome = {
  ok: false,
  failure: { kind: "other", message: "HTTP 502", retryAfterSecs: null },
};
const answered = (holdOffSecs: number | null): Outcome => ({
  ok: true,
  data: {
    remotes: [
      {
        host: REQUEST.host,
        repo: REQUEST.repo,
        openPrs: { status: "not_requested" },
        pullRequests: [],
      },
    ],
    holdOffSecs,
  },
});

async function flush() {
  for (let i = 0; i < 10; i += 1) await Promise.resolve();
}

/** A poller whose reads wait for `answer`. */
function poller() {
  const reads: ((outcome: Outcome) => void)[] = [];
  const instance = createPrPoller({
    read: () => new Promise((resolve) => reads.push(resolve)),
    deliver: () => {},
  });
  return { instance, reads };
}

describe("createPrPoller", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    vi.setSystemTime(0);
  });
  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it("does not read a remote again when a focus came while its read failed", async () => {
    const { instance, reads } = poller();
    instance.setWatch([REQUEST], false);
    await flush();
    expect(reads).toHaveLength(1);

    vi.setSystemTime(30_000);
    window.dispatchEvent(new Event("focus"));
    reads.shift()!(failed);
    await flush();
    expect(reads).toHaveLength(0);
    instance.dispose();
  });

  it("waits out the hold-off a read sets before a tick queued during it", async () => {
    const { instance, reads } = poller();
    instance.setWatch([REQUEST], false);
    await flush();

    vi.setSystemTime(60_000);
    window.dispatchEvent(new Event("focus"));
    reads.shift()!(answered(5));
    await flush();
    expect(reads).toHaveLength(0);

    // The timer reads once the hold-off is over.
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(reads).toHaveLength(1);
    instance.dispose();
  });
});

const requestGen: gs.Generator<GithubPrPollRequest> = gs
  .tuples(
    gs.sampledFrom(["example/one", "Example/One", "example/two"]),
    gs.arrays(gs.sampledFrom(["a", "b", "c"]), { maxSize: 3 }),
    gs.arrays(gs.integers({ minValue: 1, maxValue: 4 }), { maxSize: 3 })
  )
  .map(([repo, branches, numbers]) => ({
    host: "github.com",
    repo,
    branches,
    numbers,
  }));

it("merges requests into one per remote, asking for exactly what was asked", () =>
  hegel.test((tc) => {
    const requests = tc.draw(gs.arrays(requestGen, { maxSize: 6 }));
    const merged = mergeRequests(requests);
    const keys = merged.map((r) => remoteKey(r.host, r.repo));
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of new Set(requests.map((r) => remoteKey(r.host, r.repo)))) {
      const asked = requests.filter((r) => remoteKey(r.host, r.repo) === key);
      const branches = [...new Set(asked.flatMap((r) => r.branches))].sort();
      const numbers = [...new Set(asked.flatMap((r) => r.numbers))].sort(
        (a, b) => a - b
      );
      const got = merged.find((r) => remoteKey(r.host, r.repo) === key);
      if (branches.length + numbers.length === 0) {
        expect(got).toBeUndefined();
        continue;
      }
      expect(got).toEqual({
        host: "github.com",
        repo: asked[0].repo,
        branches,
        numbers,
      });
    }
  }));
