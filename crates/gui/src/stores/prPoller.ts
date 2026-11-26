import type {
  GithubFailure,
  GithubPrPollBatch,
  GithubPrPollRequest,
} from "../bindings";
import { remoteKey } from "./prLinks";
import {
  FOCUS_MIN_AGE_MS,
  PR_POLL_ACTIVE_MS,
  PR_POLL_IDLE_MS,
  needsUserFix,
  retryDelayMs,
} from "./worktreePrChecksStore";
import type { GithubOutcome } from "./worktreePrStore";

/**
 * When to ask GitHub, and nothing about what the answers mean. The PR sync
 * hands it the remotes to watch (`setWatch`) and gets every answer back
 * (`deliver`); the poller keeps no PR state.
 *
 * Watched remotes are read together every 30 s while `active` (checks
 * queued or running, a push or a re-run settling) and every 5 min otherwise,
 * not at all while the window is hidden, and again on focus. A remote whose
 * read failed waits out a backoff, or for the user when only they can fix
 * it; GitHub's rate-limit hold-off delays the next tick. A remote that joins or whose request changes is read at once.
 */

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
  /** Requests the user asked for: their refresh line shows it. */
  explicit: boolean;
  now: number;
}

export interface PrPollerOptions {
  read: (
    requests: GithubPrPollRequest[]
  ) => Promise<GithubOutcome<GithubPrPollBatch>>;
  deliver: (answer: PrPollAnswer) => void;
}

export interface PrPoller {
  /** Replace the watched remotes. */
  setWatch: (requests: GithubPrPollRequest[], active: boolean) => void;
  /** Read now: the given requests, or every watched remote not backing off. */
  pollNow: (
    requests?: GithubPrPollRequest[],
    options?: { explicit?: boolean }
  ) => Promise<void>;
  /** Stop the timer and listeners; answers in flight still land. */
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

/** Why a remote's read failed, if it did. */
function remoteFailure(
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
    if (polled.result.status === "failed") return polled.result.failure;
  return null;
}

export function createPrPoller({ read, deliver }: PrPollerOptions): PrPoller {
  let watch = new Map<string, string>();
  let watched: GithubPrPollRequest[] = [];
  let active = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let inFlight: Promise<void> | null = null;
  let lastTickAt: number | null = null;
  let holdOffUntil = 0;
  const retries = new Map<string, RemoteRetry>();
  let queued: { requests: GithubPrPollRequest[]; explicit: boolean } | null =
    null;
  /** Remotes whose request changed, read on the next microtask. */
  const changed = new Set<string>();
  /** A tick came while a read was out; it reads what is due once it lands. */
  let tickQueued = false;
  let readSoonPending = false;
  let listening = false;
  let disposed = false;

  // A failure only the user can fix waits for them (an explicit read).
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
    let due = (lastTickAt ?? now) + cadence;
    for (const request of watched) {
      const retryAt = retries.get(keyOf(request))?.retryAt ?? null;
      if (retryAt !== null) due = Math.min(due, retryAt);
    }
    return Math.max(due - now, holdOffUntil - now, 0);
  }

  function scheduleNext() {
    clearTimer();
    if (disposed || watched.length === 0) return;
    if (document.visibilityState === "hidden") return;
    timer = setTimeout(() => {
      timer = null;
      void pollNow();
    }, nextDelayMs(Date.now()));
  }

  function onFocus() {
    if (document.visibilityState === "hidden") {
      clearTimer();
      return;
    }
    const now = Date.now();
    const recent = lastTickAt !== null && now - lastTickAt < FOCUS_MIN_AGE_MS;
    if (!recent && now >= holdOffUntil) void pollNow();
    else if (timer === null && !inFlight) scheduleNext();
  }

  function listen(on: boolean) {
    if (on === listening) return;
    listening = on;
    const method = on ? "addEventListener" : "removeEventListener";
    window[method]("focus", onFocus);
    document[method]("visibilitychange", onFocus);
  }

  function enqueue(requests: GithubPrPollRequest[], explicit: boolean) {
    queued = {
      requests: mergeRequests([...(queued?.requests ?? []), ...requests]),
      explicit: explicit || !!queued?.explicit,
    };
  }

  /** The asked-for reads, and each changed remote as it is watched now. */
  function flushQueued(): Promise<void> {
    if (!queued && changed.size === 0 && !tickQueued)
      return inFlight ?? Promise.resolve();
    // Picked now, not when queued: the read that just answered may have
    // failed or set a hold-off, which a tick waits out on the timer.
    const now = Date.now();
    const tickDue = tickQueued && now >= holdOffUntil;
    const background = watched.filter(
      (request) =>
        changed.has(keyOf(request)) ||
        (tickDue && !backingOff(keyOf(request), now))
    );
    const requests = mergeRequests([
      ...(queued?.requests ?? []),
      ...background,
    ]);
    const explicit = !!queued?.explicit;
    queued = null;
    changed.clear();
    tickQueued = false;
    return start(requests, explicit);
  }

  function start(
    requests: GithubPrPollRequest[],
    explicit: boolean
  ): Promise<void> {
    clearTimer();
    const startedAt = Date.now();
    const reading = new Set(requests.map(keyOf));
    // A tick that reads nothing (everything is backing off) still counts,
    // so the next one waits a full cadence.
    if (
      watched.every(
        (request) =>
          reading.has(keyOf(request)) || backingOff(keyOf(request), startedAt)
      )
    )
      lastTickAt = startedAt;
    if (requests.length === 0) {
      scheduleNext();
      return Promise.resolve();
    }

    const shared = (async () => {
      const outcome = await read(requests);
      const now = Date.now();
      if (outcome.ok && outcome.data.holdOffSecs !== null)
        holdOffUntil = now + outcome.data.holdOffSecs * 1000;
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
            : Math.max(holdOffUntil, now + retryDelayMs(failure, attempt)),
        };
        retries.set(key, retry);
        failed.set(key, retry);
      }
      deliver({ requests, outcome, retries: failed, explicit, now });
    })().finally(() => {
      if (inFlight === shared) inFlight = null;
      if (queued || changed.size > 0 || tickQueued) void flushQueued();
      else scheduleNext();
    });
    inFlight = shared;
    return shared;
  }

  function pollNow(
    requests?: GithubPrPollRequest[],
    { explicit = false }: { explicit?: boolean } = {}
  ): Promise<void> {
    if (inFlight) {
      if (!requests) tickQueued = true;
      else if (requests.length > 0) enqueue(mergeRequests(requests), explicit);
      return inFlight.then(() => flushQueued());
    }
    const now = Date.now();
    const wanted = mergeRequests(
      requests ?? watched.filter((request) => !backingOff(keyOf(request), now))
    );
    return start(wanted, explicit);
  }

  /** Changed remotes are read together on the next microtask, as then watched. */
  function readSoon(keys: string[]) {
    for (const key of keys) changed.add(key);
    if (readSoonPending) return;
    readSoonPending = true;
    queueMicrotask(() => {
      readSoonPending = false;
      if (!inFlight && !disposed) void flushQueued();
    });
  }

  function setWatch(requests: GithubPrPollRequest[], nextActive: boolean) {
    watched = mergeRequests(requests);
    const previous = watch;
    watch = new Map(
      watched.map((request) => [keyOf(request), JSON.stringify(request)])
    );
    for (const key of retries.keys()) if (!watch.has(key)) retries.delete(key);
    const changedKeys = [...watch.keys()].filter(
      (key) => previous.get(key) !== watch.get(key)
    );
    active = nextActive;
    listen(watched.length > 0);
    if (changedKeys.length > 0) readSoon(changedKeys);
    else if (!inFlight) scheduleNext();
  }

  function dispose() {
    disposed = true;
    clearTimer();
    listen(false);
    watched = [];
    watch = new Map();
    queued = null;
    changed.clear();
    tickQueued = false;
  }

  return { setWatch, pollNow, dispose };
}
