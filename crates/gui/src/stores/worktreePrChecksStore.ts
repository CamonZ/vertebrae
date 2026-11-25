import { create } from "zustand";
import {
  commands,
  type GithubFailure,
  type GithubPrChecks,
  type WorktreePrAssociation,
} from "../bindings";
import {
  githubFailureOf,
  linkedPullRequest,
  useWorktreePrStore,
  worktreePrKey,
} from "./worktreePrStore";

/**
 * Checks for the PR linked to a worktree branch. One entry per
 * worktree+branch feeds the review bar, the checks drawer and the chat
 * header chip, so every surface shows the same refresh.
 *
 * GitHub is asked again on window focus, after a push (the branch's local
 * remote-tracking ref moved), on demand, and on a light poll only while a
 * check is queued or running. Every read is a conditional request.
 */

/** A failed refresh retries after this, doubling up to the cap. */
export const CHECKS_RETRY_BASE_MS = 15_000;
export const CHECKS_RETRY_MAX_MS = 5 * 60_000;
/** Checks older than this, with no refresh pending, are shown as stale. */
export const CHECKS_STALE_AFTER_MS = 10 * 60_000;
/** Local-only probe of the remote-tracking ref, to notice a push. */
export const PUBLISHED_HEAD_PROBE_MS = 10_000;
/** After a push, how often to ask until GitHub reports the new head. */
export const AWAITING_PUSH_POLL_MS = 5_000;
export const AWAITING_PUSH_MAX_POLLS = 12;
/** A re-run GitHub accepted but has not shown yet stops overriding after this. */
export const RERUN_PENDING_MAX_MS = 3 * 60_000;
/** A focus refresh is skipped when the last read is this recent. */
const FOCUS_MIN_AGE_MS = 10_000;

export type PrChecksRefresh =
  | { status: "idle" }
  | { status: "refreshing" }
  | {
      status: "failed";
      failure: GithubFailure;
      /** `null` when only the user can fix it (gh missing, signed out). */
      retryAt: number | null;
      attempt: number;
    };

/**
 * A re-run request for one check id. `requested` means GitHub accepted it;
 * the check shows as queued until GitHub reports the new attempt.
 */
export type PrRerunState =
  | { status: "requesting" }
  | { status: "requested"; at: number }
  | { status: "failed"; message: string };

export interface PrChecksEntry {
  /** The linked PR these checks belong to. */
  prNumber: number | null;
  snapshot: GithubPrChecks | null;
  fetchedAt: number | null;
  refresh: PrChecksRefresh;
  reruns: Readonly<Record<string, PrRerunState>>;
  /** A pushed commit GitHub has not reported as the PR head yet. */
  awaitingHead: string | null;
}

export const IDLE_CHECKS_ENTRY: PrChecksEntry = {
  prNumber: null,
  snapshot: null,
  fetchedAt: null,
  refresh: { status: "idle" },
  reruns: {},
  awaitingHead: null,
};

interface ChecksStoreState {
  entries: Record<string, PrChecksEntry>;
}

export const useWorktreePrChecksStore = create<ChecksStoreState>(() => ({
  entries: {},
}));

interface Subscription {
  worktreePath: string;
  branch: string;
  consumers: number;
  unsubscribe: () => void;
  probe: ReturnType<typeof setInterval>;
  timer: ReturnType<typeof setTimeout> | null;
  inFlight: Promise<void> | null;
  request: number;
  publishedHead: string | null | undefined;
  awaitingPolls: number;
  /** Consecutive failed reads; drives the backoff across "refreshing". */
  failures: number;
}

const subscriptions = new Map<string, Subscription>();
let requestCounter = 0;
let focusListener: (() => void) | null = null;

function entryOf(key: string): PrChecksEntry {
  return useWorktreePrChecksStore.getState().entries[key] ?? IDLE_CHECKS_ENTRY;
}

function update(key: string, next: (entry: PrChecksEntry) => PrChecksEntry) {
  useWorktreePrChecksStore.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: next(state.entries[key] ?? IDLE_CHECKS_ENTRY),
    },
  }));
}

function needsUserFix(failure: GithubFailure): boolean {
  return failure.kind === "gh_missing" || failure.kind === "auth_expired";
}

export function retryDelayMs(failure: GithubFailure, attempt: number): number {
  if (failure.retryAfterSecs !== null)
    return Math.max(failure.retryAfterSecs * 1000, CHECKS_RETRY_BASE_MS);
  return Math.min(
    CHECKS_RETRY_BASE_MS * 2 ** Math.max(0, attempt - 1),
    CHECKS_RETRY_MAX_MS
  );
}

/**
 * Drops re-run overrides GitHub has caught up with: the failed attempt was
 * replaced (new id) or no longer failed, or the request is too old to trust.
 */
export function reconcileReruns(
  reruns: Readonly<Record<string, PrRerunState>>,
  snapshot: GithubPrChecks,
  now: number
): Readonly<Record<string, PrRerunState>> {
  const failedIds = new Set(
    snapshot.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id)
  );
  const kept: Record<string, PrRerunState> = {};
  for (const [id, state] of Object.entries(reruns)) {
    if (state.status === "requesting") kept[id] = state;
    else if (!failedIds.has(id)) continue;
    else if (state.status === "failed") kept[id] = state;
    else if (now - state.at < RERUN_PENDING_MAX_MS) kept[id] = state;
  }
  return kept;
}

function clearTimer(sub: Subscription) {
  if (sub.timer !== null) clearTimeout(sub.timer);
  sub.timer = null;
}

function schedule(key: string, sub: Subscription, delayMs: number | null) {
  clearTimer(sub);
  if (delayMs === null) return;
  sub.timer = setTimeout(() => {
    sub.timer = null;
    if (subscriptions.get(key) === sub) void fetchChecks(key);
  }, delayMs);
}

function nextPollMs(sub: Subscription, entry: PrChecksEntry): number | null {
  const snapshot = entry.snapshot;
  if (!snapshot) return null;
  const waits: number[] = [];
  if (snapshot.pollAfterSecs !== null)
    waits.push(snapshot.pollAfterSecs * 1000);
  if (
    entry.awaitingHead !== null &&
    sub.awaitingPolls < AWAITING_PUSH_MAX_POLLS
  )
    waits.push(AWAITING_PUSH_POLL_MS);
  if (Object.values(entry.reruns).some((state) => state.status === "requested"))
    waits.push(CHECKS_RETRY_BASE_MS);
  return waits.length > 0 ? Math.min(...waits) : null;
}

function fetchChecks(key: string): Promise<void> {
  const sub = subscriptions.get(key);
  if (!sub) return Promise.resolve();
  if (sub.inFlight) return sub.inFlight;
  const prNumber = entryOf(key).prNumber;
  if (prNumber === null) return Promise.resolve();

  clearTimer(sub);
  requestCounter += 1;
  const request = requestCounter;
  sub.request = request;
  update(key, (entry) => ({ ...entry, refresh: { status: "refreshing" } }));

  const read = (async () => {
    let outcome:
      | { ok: true; data: GithubPrChecks }
      | { ok: false; failure: GithubFailure };
    try {
      const result = await commands.getWorktreePrChecks(
        sub.worktreePath,
        sub.branch
      );
      outcome =
        result.status === "ok"
          ? { ok: true, data: result.data }
          : { ok: false, failure: result.error };
    } catch (error) {
      outcome = { ok: false, failure: githubFailureOf(error) };
    }
    // Superseded by a newer read, a PR change, or release.
    if (subscriptions.get(key) !== sub || sub.request !== request) return;
    const current = entryOf(key);
    if (current.prNumber !== prNumber) return;
    if (outcome.ok && outcome.data.prNumber !== prNumber) return;

    const now = Date.now();
    if (outcome.ok) {
      const snapshot = outcome.data;
      const caughtUp =
        current.awaitingHead === null ||
        snapshot.headSha === current.awaitingHead;
      if (current.awaitingHead !== null && !caughtUp) sub.awaitingPolls += 1;
      const giveUp = sub.awaitingPolls >= AWAITING_PUSH_MAX_POLLS;
      update(key, (entry) => ({
        ...entry,
        snapshot,
        fetchedAt: now,
        refresh: { status: "idle" },
        reruns: reconcileReruns(entry.reruns, snapshot, now),
        awaitingHead: caughtUp || giveUp ? null : entry.awaitingHead,
      }));
      if (caughtUp || giveUp) sub.awaitingPolls = 0;
      sub.failures = 0;
      schedule(key, sub, nextPollMs(sub, entryOf(key)));
      return;
    }

    const failure = outcome.failure;
    sub.failures += 1;
    const attempt = sub.failures;
    const delay = needsUserFix(failure) ? null : retryDelayMs(failure, attempt);
    update(key, (entry) => ({
      ...entry,
      refresh: {
        status: "failed",
        failure,
        retryAt: delay === null ? null : now + delay,
        attempt,
      },
    }));
    schedule(key, sub, delay);
  })();

  const shared = read.finally(() => {
    if (sub.inFlight === shared) sub.inFlight = null;
  });
  sub.inFlight = shared;
  return shared;
}

async function probePublishedHead(key: string) {
  const sub = subscriptions.get(key);
  if (!sub || document.visibilityState === "hidden") return;
  let head: string | null;
  try {
    const result = await commands.getWorktreePublishedHead(
      sub.worktreePath,
      sub.branch
    );
    if (result.status !== "ok") return;
    head = result.data;
  } catch {
    return;
  }
  if (subscriptions.get(key) !== sub) return;
  const previous = sub.publishedHead;
  sub.publishedHead = head;
  // The first probe only records where the branch was.
  if (previous === undefined || previous === head || head === null) return;
  const entry = entryOf(key);
  if (entry.prNumber === null) return;
  sub.awaitingPolls = 0;
  update(key, (current) => ({
    ...current,
    awaitingHead: current.snapshot?.headSha === head ? null : head,
  }));
  void refreshNow(key);
}

function refreshNow(key: string): Promise<void> {
  const sub = subscriptions.get(key);
  if (!sub) return Promise.resolve();
  if (sub.inFlight) {
    // Ask again once the running read lands, so the answer is current.
    return sub.inFlight.then(() => fetchChecks(key));
  }
  return fetchChecks(key);
}

function onFocus() {
  if (document.visibilityState === "hidden") return;
  const now = Date.now();
  for (const key of subscriptions.keys()) {
    const entry = entryOf(key);
    if (entry.prNumber === null || entry.refresh.status === "refreshing")
      continue;
    if (entry.fetchedAt !== null && now - entry.fetchedAt < FOCUS_MIN_AGE_MS)
      continue;
    void fetchChecks(key);
  }
}

function ensureFocusListener() {
  if (focusListener) return;
  focusListener = onFocus;
  window.addEventListener("focus", focusListener);
  document.addEventListener("visibilitychange", focusListener);
}

function releaseFocusListener() {
  if (!focusListener || subscriptions.size > 0) return;
  window.removeEventListener("focus", focusListener);
  document.removeEventListener("visibilitychange", focusListener);
  focusListener = null;
}

function linkedNumber(association: WorktreePrAssociation | null) {
  return linkedPullRequest(association)?.number ?? null;
}

/** Follows the association: a newly linked PR starts fresh, an unlink clears. */
function syncWithAssociation(key: string) {
  const sub = subscriptions.get(key);
  if (!sub) return;
  const prNumber = linkedNumber(
    useWorktreePrStore.getState().entries[key]?.association ?? null
  );
  if (entryOf(key).prNumber === prNumber) return;
  clearTimer(sub);
  sub.inFlight = null;
  sub.request = 0;
  sub.awaitingPolls = 0;
  sub.failures = 0;
  update(key, () => ({ ...IDLE_CHECKS_ENTRY, prNumber }));
  if (prNumber !== null) void fetchChecks(key);
}

function dispose(key: string) {
  const sub = subscriptions.get(key);
  if (!sub) return;
  sub.unsubscribe();
  clearInterval(sub.probe);
  clearTimer(sub);
  subscriptions.delete(key);
  useWorktreePrChecksStore.setState((state) => {
    if (!(key in state.entries)) return state;
    const entries = { ...state.entries };
    delete entries[key];
    return { entries };
  });
  releaseFocusListener();
}

/**
 * Starts following checks for the branch's linked PR. Pair with
 * `acquireWorktreePr`, which owns the association it follows. Release is
 * deferred one microtask so a Strict Mode remount keeps the entry.
 */
export function acquireWorktreePrChecks(
  worktreePath: string,
  branch: string
): () => void {
  const key = worktreePrKey(worktreePath, branch);
  let sub = subscriptions.get(key);
  if (sub) {
    sub.consumers += 1;
  } else {
    const created: Subscription = {
      worktreePath,
      branch,
      consumers: 1,
      unsubscribe: () => {},
      probe: setInterval(
        () => void probePublishedHead(key),
        PUBLISHED_HEAD_PROBE_MS
      ),
      timer: null,
      inFlight: null,
      request: 0,
      publishedHead: undefined,
      awaitingPolls: 0,
      failures: 0,
    };
    subscriptions.set(key, created);
    created.unsubscribe = useWorktreePrStore.subscribe((state, previous) => {
      if (
        state.entries[key]?.association !== previous.entries[key]?.association
      )
        syncWithAssociation(key);
    });
    ensureFocusListener();
    syncWithAssociation(key);
    void probePublishedHead(key);
    sub = created;
  }

  const owned = sub;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    owned.consumers -= 1;
    queueMicrotask(() => {
      if (subscriptions.get(key) === owned && owned.consumers <= 0)
        dispose(key);
    });
  };
}

export function refreshWorktreePrChecks(
  worktreePath: string,
  branch: string
): Promise<void> {
  return refreshNow(worktreePrKey(worktreePath, branch));
}

/**
 * Asks GitHub to re-run one failed Actions job. The request is sent once:
 * on any failure the checks are refreshed so the user sees whether GitHub
 * queued it anyway before trying again.
 */
export async function rerunWorktreePrCheck(
  worktreePath: string,
  branch: string,
  checkId: string
): Promise<void> {
  const key = worktreePrKey(worktreePath, branch);
  const sub = subscriptions.get(key);
  const prNumber = entryOf(key).prNumber;
  if (!sub || prNumber === null) return;
  if (entryOf(key).reruns[checkId]?.status === "requesting") return;

  const setRerun = (state: PrRerunState) =>
    update(key, (entry) =>
      entry.prNumber === prNumber
        ? { ...entry, reruns: { ...entry.reruns, [checkId]: state } }
        : entry
    );
  setRerun({ status: "requesting" });
  let failure: GithubFailure | null = null;
  try {
    const result = await commands.rerunWorktreePrCheck(
      worktreePath,
      branch,
      checkId
    );
    if (result.status === "error") failure = result.error;
  } catch (error) {
    failure = githubFailureOf(error);
  }
  if (subscriptions.get(key) !== sub) return;
  setRerun(
    failure
      ? { status: "failed", message: failure.message }
      : { status: "requested", at: Date.now() }
  );
  await refreshNow(key);
}

export function resetWorktreePrChecksStore() {
  for (const key of [...subscriptions.keys()]) dispose(key);
  requestCounter = 0;
  useWorktreePrChecksStore.setState({ entries: {} });
}
