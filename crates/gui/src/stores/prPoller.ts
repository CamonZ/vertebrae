import type {
  GithubFailure,
  GithubPrPollBatch,
  GithubPrPollRequest,
} from "../bindings";
import { remoteKey } from "./prLinks";
import { needsUserFix, type GithubOutcome } from "./worktreePrStore";

/**
 * When to ask GitHub, and nothing about what the answers mean. The PR sync
 * hands it the remotes to watch (`setWatch`) and gets every answer back
 * (`deliver`); the poller keeps no PR state.
 *
 * Reads come from two lanes, drained one read at a time:
 *
 * - asked reads (a refresh, a one-shot read, the read after a write) go
 *   out at once;
 * - watched remotes become due on each tick (every 30 s while `active`:
 *   checks queued or running, a push or a re-run settling; every 5 min
 *   otherwise), on focus, and when their request changes. A due remote is
 *   read only while the window is visible, GitHub's rate-limit hold-off is
 *   over and its own backoff is too; a remote only the user can fix waits
 *   for an asked read.
 */

/** Tick interval while anything is queued, running or settling. */
export const PR_POLL_ACTIVE_MS = 30_000;
/** Tick interval when every check has finished. */
export const PR_POLL_IDLE_MS = 5 * 60_000;
/** A failed read retries after this, doubling up to the cap. */
export const RETRY_BASE_MS = 30_000;
export const RETRY_MAX_MS = 5 * 60_000;
/** Focus reads again only when the last tick is at least this old. */
export const FOCUS_MIN_AGE_MS = 30_000;

export function retryDelayMs(failure: GithubFailure, attempt: number): number {
  if (failure.retryAfterSecs !== null)
    return Math.max(failure.retryAfterSecs * 1000, RETRY_BASE_MS);
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1), RETRY_MAX_MS);
}

export interface RemoteRetry {
  failure: GithubFailure;
  attempt: number;
  /** `null` when only the user can fix it (gh missing, signed out). */
  retryAt: number | null;
}

export interface PrPollAnswer {
  requests: GithubPrPollRequest[];
  outcome: GithubOutcome<GithubPrPollBatch>;
  /** Remotes whose read failed this time, with their next retry. */
  retries: ReadonlyMap<string, RemoteRetry>;
  now: number;
}

export interface PrPollerOptions {
  read: (
    requests: GithubPrPollRequest[]
  ) => Promise<GithubOutcome<GithubPrPollBatch>>;
  deliver: (answer: PrPollAnswer) => void;
}

export interface PrPoller {
  /** Replace the watched remotes; a remote whose request changed is due. */
  setWatch: (requests: GithubPrPollRequest[], active: boolean) => void;
  /**
   * Read the given requests now, or (without any) make every watched remote
   * due, as a tick does.
   */
  pollNow: (requests?: GithubPrPollRequest[]) => Promise<void>;
  /** Stop the timer and listeners; answers in flight are dropped. */
  dispose: () => void;
}

const keyOf = (request: GithubPrPollRequest) =>
  remoteKey(request.host, request.repo);

/** One request per remote, its branches and numbers joined. */
export function mergeRequests(
  requests: readonly GithubPrPollRequest[]
): GithubPrPollRequest[] {
  const merged = new Map<string, GithubPrPollRequest>();
  for (const request of requests) {
    const key = keyOf(request);
    const into = merged.get(key);
    merged.set(key, {
      host: into?.host ?? request.host,
      repo: into?.repo ?? request.repo,
      branches: [
        ...new Set([...(into?.branches ?? []), ...request.branches]),
      ].sort(),
      numbers: [
        ...new Set([...(into?.numbers ?? []), ...request.numbers]),
      ].sort((a, b) => a - b),
    });
  }
  return [...merged.values()].filter(
    (request) => request.branches.length > 0 || request.numbers.length > 0
  );
}

const sameRequest = (a: GithubPrPollRequest, b: GithubPrPollRequest) =>
  a.repo === b.repo &&
  a.branches.length === b.branches.length &&
  a.branches.every((branch, i) => branch === b.branches[i]) &&
  a.numbers.length === b.numbers.length &&
  a.numbers.every((number, i) => number === b.numbers[i]);

/**
 * Why a remote's read failed, if it did. A PR GitHub does not find is that
 * PR's failure, not the remote's: its siblings keep their cadence.
 */
export function remoteFailure(
  key: string,
  outcome: GithubOutcome<GithubPrPollBatch>
): GithubFailure | null {
  if (!outcome.ok) return outcome.failure;
  const remote = outcome.data.remotes.find(
    (polled) => remoteKey(polled.host, polled.repo) === key
  );
  if (!remote) return null;
  if (remote.openPrs.status === "failed") return remote.openPrs.failure;
  for (const polled of remote.pullRequests)
    if (
      polled.result.status === "failed" &&
      polled.result.failure.kind !== "not_found"
    )
      return polled.result.failure;
  return null;
}

export function createPrPoller({ read, deliver }: PrPollerOptions): PrPoller {
  let watched = new Map<string, GithubPrPollRequest>();
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let lastTickAt: number | null = null;
  let holdOffUntil = 0;
  const retries = new Map<string, RemoteRetry>();
  /** Asked reads: never gated. */
  let asked: GithubPrPollRequest[] = [];
  /** Watched remotes due for a read, gated when drained. */
  const due = new Set<string>();
  let drainScheduled = false;
  let listening = false;
  let disposed = false;

  const hidden = () => document.visibilityState === "hidden";

  // A failure only the user can fix waits for them (an asked read).
  const backingOff = (key: string, now: number) => {
    const retry = retries.get(key);
    return !!retry && (retry.retryAt === null || retry.retryAt > now);
  };

  function clearTimer() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
  }

  function nextDelayMs(now: number): number {
    const cadence = active ? PR_POLL_ACTIVE_MS : PR_POLL_IDLE_MS;
    let next = (lastTickAt ?? now) + cadence;
    for (const key of watched.keys()) {
      const retryAt = retries.get(key)?.retryAt ?? null;
      if (retryAt !== null) next = Math.min(next, retryAt);
    }
    return Math.max(next - now, holdOffUntil - now, 0);
  }

  function scheduleNext() {
    clearTimer();
    if (disposed || inFlight || watched.size === 0 || hidden()) return;
    timer = setTimeout(() => {
      timer = null;
      tick();
    }, nextDelayMs(Date.now()));
  }

  function tick() {
    for (const key of watched.keys()) due.add(key);
    scheduleDrain();
  }

  function onFocus() {
    if (hidden()) {
      clearTimer();
      return;
    }
    const now = Date.now();
    const recent = lastTickAt !== null && now - lastTickAt < FOCUS_MIN_AGE_MS;
    if (!recent) tick();
    else if (timer === null) scheduleNext();
  }

  function listen(on: boolean) {
    if (on === listening) return;
    listening = on;
    const method = on ? "addEventListener" : "removeEventListener";
    window[method]("focus", onFocus);
    document[method]("visibilitychange", onFocus);
  }

  function scheduleDrain() {
    if (drainScheduled) return;
    drainScheduled = true;
    queueMicrotask(() => {
      drainScheduled = false;
      void drain();
    });
  }

  /** Starts the next read: everything asked, and every due remote allowed now. */
  function drain(): Promise<void> {
    if (disposed) return Promise.resolve();
    if (inFlight) return inFlight.then(drain);
    const now = Date.now();
    const open = !hidden() && now >= holdOffUntil;
    const wasDue = due.size > 0;
    const background = [...due]
      .filter((key) => open && !backingOff(key, now))
      .flatMap((key) => watched.get(key) ?? []);
    due.clear();
    const requests = mergeRequests([...asked, ...background]);
    asked = [];

    const reading = new Set(requests.map(keyOf));
    // A tick that reads nothing (everything is backing off) still counts,
    // so the next one waits a full cadence.
    if (
      wasDue &&
      [...watched.keys()].every(
        (key) => reading.has(key) || backingOff(key, now)
      )
    )
      lastTickAt = now;
    if (requests.length === 0) {
      scheduleNext();
      return Promise.resolve();
    }
    clearTimer();

    const shared = (async () => {
      const outcome = await read(requests);
      if (disposed) return;
      const at = Date.now();
      if (outcome.ok && outcome.data.holdOffSecs !== null)
        // GitHub's latest budget replaces the last hold-off.
        holdOffUntil = at + outcome.data.holdOffSecs * 1000;
      const failed = new Map<string, RemoteRetry>();
      for (const key of reading) {
        const failure = remoteFailure(key, outcome);
        if (!failure) {
          retries.delete(key);
          continue;
        }
        const attempt = (retries.get(key)?.attempt ?? 0) + 1;
        const retry: RemoteRetry = {
          failure,
          attempt,
          retryAt: needsUserFix(failure)
            ? null
            : Math.max(holdOffUntil, at + retryDelayMs(failure, attempt)),
        };
        retries.set(key, retry);
        failed.set(key, retry);
      }
      deliver({ requests, outcome, retries: failed, now: at });
    })().finally(() => {
      inFlight = null;
      if (asked.length > 0 || due.size > 0) void drain();
      else scheduleNext();
    });
    inFlight = shared;
    return shared;
  }

  function pollNow(requests?: GithubPrPollRequest[]): Promise<void> {
    if (requests) asked.push(...requests);
    else for (const key of watched.keys()) due.add(key);
    return drain();
  }

  function setWatch(requests: GithubPrPollRequest[], nextActive: boolean) {
    const previous = watched;
    watched = new Map(
      mergeRequests(requests).map((request) => [keyOf(request), request])
    );
    for (const key of retries.keys())
      if (!watched.has(key)) retries.delete(key);
    for (const key of due) if (!watched.has(key)) due.delete(key);
    active = nextActive;
    listen(watched.size > 0);
    let changed = false;
    for (const [key, request] of watched) {
      const before = previous.get(key);
      if (before && sameRequest(before, request)) continue;
      due.add(key);
      changed = true;
    }
    if (changed) scheduleDrain();
    else if (!inFlight) scheduleNext();
  }

  function dispose() {
    disposed = true;
    clearTimer();
    listen(false);
    watched = new Map();
    asked = [];
    due.clear();
  }

  return { setWatch, pollNow, dispose };
}
