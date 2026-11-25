import { create } from "zustand";
import {
  commands,
  type GithubFailure,
  type GithubPrChecks,
  type GithubPullRequest,
  type WorktreeBranch,
  type WorktreePrAssociation,
  type WorktreePrPoll,
} from "../bindings";
import {
  githubFailureOf,
  linkedPullRequest,
  receivePolledPr,
  useWorktreePrStore,
  worktreePrKey,
} from "./worktreePrStore";

/**
 * One poller for the linked PRs of every watched worktree branch: those shown
 * on screen (`acquireWorktreePrChecks`) and those of chats on unfinished
 * tickets (`setWatchedPrWorktrees`). Each tick is a single backend call that
 * asks GitHub once per repository for the PRs and their checks, so the
 * review bar, the checks drawer and the header chip read one entry.
 *
 * Ticks run every 30 s while any check is queued or running (or a push,
 * re-run or cancel is settling) and every 5 min otherwise, and stop while
 * the window is hidden. Focus, a push to a shown branch and Refresh read
 * sooner.
 */

/** Tick interval while anything is queued, running or settling. */
export const PR_POLL_ACTIVE_MS = 30_000;
/** Tick interval when every check has finished. */
export const PR_POLL_IDLE_MS = 5 * 60_000;
/** A failed read retries after this, doubling up to the cap. */
export const CHECKS_RETRY_BASE_MS = 30_000;
export const CHECKS_RETRY_MAX_MS = 5 * 60_000;
/** Checks older than this, with no read pending, are shown as stale. */
export const CHECKS_STALE_AFTER_MS = 2 * PR_POLL_IDLE_MS;
/** Local-only probe of a shown branch's remote-tracking ref, to see a push. */
export const PUBLISHED_HEAD_PROBE_MS = 10_000;
/** Active ticks spent waiting for GitHub to report a pushed head. */
export const AWAITING_PUSH_MAX_POLLS = 10;
/** An accepted re-run or cancel GitHub has not shown yet stops overriding. */
export const WRITE_PENDING_MAX_MS = 3 * 60_000;
/** Focus reads again only when the last tick is at least this old. */
export const FOCUS_MIN_AGE_MS = 30_000;

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
 * A re-run (keyed by check id) or cancel (keyed by workflow run) request.
 * `requested` means GitHub accepted it; the view overrides the checks until
 * GitHub reports the result.
 */
export type PrWriteState =
  | { status: "requesting" }
  | { status: "requested"; at: number }
  | { status: "failed"; message: string };

export interface PrChecksEntry {
  /** The linked PR these checks belong to. */
  prNumber: number | null;
  /** The linked PR as last read with its checks. */
  pr: GithubPullRequest | null;
  snapshot: GithubPrChecks | null;
  fetchedAt: number | null;
  refresh: PrChecksRefresh;
  reruns: Readonly<Record<string, PrWriteState>>;
  cancels: Readonly<Record<string, PrWriteState>>;
  /** A pushed commit GitHub has not reported as the PR head yet. */
  awaitingHead: string | null;
}

export const IDLE_CHECKS_ENTRY: PrChecksEntry = {
  prNumber: null,
  pr: null,
  snapshot: null,
  fetchedAt: null,
  refresh: { status: "idle" },
  reruns: {},
  cancels: {},
  awaitingHead: null,
};

interface ChecksStoreState {
  entries: Record<string, PrChecksEntry>;
}

export const useWorktreePrChecksStore = create<ChecksStoreState>(() => ({
  entries: {},
}));

interface Target {
  worktreePath: string;
  branch: string;
  /** Mounted readers; a shown branch also probes for pushes. */
  consumers: number;
  /** Watched as the worktree of a chat on an unfinished ticket. */
  watched: boolean;
  /** Bumped when the linked PR changes, so older answers are dropped. */
  generation: number;
  /** The linked PR as the association store last said; undefined unread. */
  linkedAs: number | null | undefined;
  probe: ReturnType<typeof setInterval> | null;
  publishedHead: string | null | undefined;
  awaitingPolls: number;
  failures: number;
}

const targets = new Map<string, Target>();
/** Keys in the read now in flight. */
const reading = new Set<string>();
let timer: ReturnType<typeof setTimeout> | null = null;
let inFlight: Promise<void> | null = null;
let lastTickAt: number | null = null;
let holdOffUntil = 0;
/** Keys to read once the current read lands; true when the user asked. */
const queued = new Map<string, boolean>();
let queuedFlush = false;
let unsubscribeAssociations: (() => void) | null = null;
let focusListener: (() => void) | null = null;

function entryOf(key: string): PrChecksEntry {
  return useWorktreePrChecksStore.getState().entries[key] ?? IDLE_CHECKS_ENTRY;
}

function update(key: string, next: (entry: PrChecksEntry) => PrChecksEntry) {
  if (!targets.has(key)) return;
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

const isPending = (status: string) =>
  status === "running" || status === "queued";

/**
 * Drops overrides GitHub has caught up with: a re-run whose failed attempt
 * was replaced or no longer failed, a cancel whose run has no pending job
 * left, or a request too old to trust.
 */
export function reconcileWrites(
  entry: Pick<PrChecksEntry, "reruns" | "cancels">,
  snapshot: GithubPrChecks,
  now: number
): Pick<PrChecksEntry, "reruns" | "cancels"> {
  const failedIds = new Set(
    snapshot.checks
      .filter((check) => check.status === "failed")
      .map((check) => check.id)
  );
  const pendingRuns = new Set(
    snapshot.checks
      .filter((check) => isPending(check.status) && check.actionsRun)
      .map((check) => check.actionsRun as string)
  );
  const keep = (
    writes: Readonly<Record<string, PrWriteState>>,
    live: Set<string>
  ) => {
    const kept: Record<string, PrWriteState> = {};
    for (const [id, state] of Object.entries(writes)) {
      if (state.status === "requesting") kept[id] = state;
      else if (!live.has(id)) continue;
      else if (state.status === "failed") kept[id] = state;
      else if (now - state.at < WRITE_PENDING_MAX_MS) kept[id] = state;
    }
    return kept;
  };
  return {
    reruns: keep(entry.reruns, failedIds),
    cancels: keep(entry.cancels, pendingRuns),
  };
}

function hasRequested(writes: Readonly<Record<string, PrWriteState>>) {
  return Object.values(writes).some((state) => state.status === "requested");
}

/** Anything that needs the 30 s cadence: running CI or a settling change. */
function isActive(key: string, target: Target): boolean {
  const entry = entryOf(key);
  if (entry.prNumber === null) return false;
  return (
    Boolean(entry.snapshot?.checks.some((check) => isPending(check.status))) ||
    (entry.awaitingHead !== null &&
      target.awaitingPolls < AWAITING_PUSH_MAX_POLLS) ||
    hasRequested(entry.reruns) ||
    hasRequested(entry.cancels)
  );
}

function nextDelayMs(now: number): number {
  let delay = PR_POLL_IDLE_MS;
  for (const [key, target] of targets) {
    if (isActive(key, target)) delay = Math.min(delay, PR_POLL_ACTIVE_MS);
    const refresh = entryOf(key).refresh;
    if (refresh.status === "failed" && refresh.retryAt !== null)
      delay = Math.min(delay, Math.max(0, refresh.retryAt - now));
  }
  return Math.max(delay, holdOffUntil - now, 0);
}

function clearTimer() {
  if (timer !== null) clearTimeout(timer);
  timer = null;
}

function scheduleNext() {
  clearTimer();
  if (targets.size === 0 || document.visibilityState === "hidden") return;
  timer = setTimeout(() => {
    timer = null;
    void pollKeys([...targets.keys()], false);
  }, nextDelayMs(Date.now()));
}

function associationNumber(key: string): number | null | undefined {
  const entry = useWorktreePrStore.getState().entries[key];
  if (!entry || entry.association === null) return undefined;
  return linkedPullRequest(entry.association)?.number ?? null;
}

function applyResult(
  key: string,
  target: Target,
  generation: number,
  poll: WorktreePrPoll,
  now: number,
  retryAt: number
) {
  if (targets.get(key) !== target || target.generation !== generation) return;
  const known = associationNumber(key);
  const result = poll.result;
  if (result.status === "linked") {
    const checks = result.checks;
    // The user linked another PR (or unlinked) meanwhile.
    if (known !== undefined && known !== checks.prNumber) return;
    const current = entryOf(key);
    const caughtUp =
      current.awaitingHead === null || checks.headSha === current.awaitingHead;
    if (!caughtUp) target.awaitingPolls += 1;
    const giveUp = target.awaitingPolls >= AWAITING_PUSH_MAX_POLLS;
    if (caughtUp || giveUp) target.awaitingPolls = 0;
    target.failures = 0;
    update(key, (entry) => ({
      ...entry,
      prNumber: checks.prNumber,
      pr: linkedPullRequest(result.association),
      snapshot: checks,
      fetchedAt: now,
      refresh: { status: "idle" },
      ...reconcileWrites(entry, checks, now),
      awaitingHead: caughtUp || giveUp ? null : entry.awaitingHead,
    }));
    receivePolledPr(target.worktreePath, target.branch, result.association);
    return;
  }
  if (result.status === "not_linked") {
    if (known !== undefined && known !== null) return;
    target.failures = 0;
    update(key, () => IDLE_CHECKS_ENTRY);
    return;
  }
  const failure = result.failure;
  target.failures += 1;
  const attempt = target.failures;
  const userFix = needsUserFix(failure);
  update(key, (entry) => ({
    ...entry,
    refresh: {
      status: "failed",
      failure,
      retryAt: userFix
        ? null
        : Math.max(retryAt, now + retryDelayMs(failure, attempt)),
      attempt,
    },
  }));
}

/**
 * Reads the given branches in one backend call. A background tick leaves the
 * refresh line alone; an explicit read shows it refreshing.
 */
function pollKeys(keys: string[], explicit: boolean): Promise<void> {
  if (inFlight) {
    for (const key of keys) queued.set(key, explicit || !!queued.get(key));
    return inFlight.then(() => flushQueued());
  }
  const batch = keys
    .map((key) => [key, targets.get(key)] as const)
    .filter((pair): pair is readonly [string, Target] => pair[1] !== undefined);
  if (batch.length === 0) {
    scheduleNext();
    return Promise.resolve();
  }
  clearTimer();
  const generations = new Map(
    batch.map(([key, target]) => [key, target.generation])
  );
  for (const [key] of batch) reading.add(key);
  if (explicit)
    for (const [key] of batch)
      update(key, (current) => ({
        ...current,
        refresh: { status: "refreshing" },
      }));
  const request: WorktreeBranch[] = batch.map(([, target]) => ({
    worktreePath: target.worktreePath,
    branch: target.branch,
  }));

  const read = (async () => {
    let results: WorktreePrPoll[];
    let holdOffSecs: number | null = null;
    try {
      const response = await commands.pollWorktreePrs(request);
      if (response.status === "error") throw response.error;
      results = response.data.results;
      holdOffSecs = response.data.holdOffSecs;
    } catch (error) {
      const failure =
        error && typeof error === "object" && "kind" in error
          ? (error as GithubFailure)
          : githubFailureOf(error);
      results = request.map((target) => ({
        ...target,
        result: { status: "failed", failure },
      }));
    }
    const now = Date.now();
    lastTickAt = now;
    if (holdOffSecs !== null) holdOffUntil = now + holdOffSecs * 1000;
    for (const poll of results) {
      const key = worktreePrKey(poll.worktreePath, poll.branch);
      const target = targets.get(key);
      const generation = generations.get(key);
      if (target && generation !== undefined)
        applyResult(key, target, generation, poll, now, holdOffUntil);
    }
  })();

  const shared = read.finally(() => {
    if (inFlight === shared) inFlight = null;
    for (const [key] of batch) reading.delete(key);
    if (queued.size > 0) void flushQueued();
    else scheduleNext();
  });
  inFlight = shared;
  return shared;
}

/** Reads the queued keys, or joins the read that already took them. */
function flushQueued(): Promise<void> {
  if (queued.size === 0) return inFlight ?? Promise.resolve();
  const keys = [...queued.keys()];
  const explicit = [...queued.values()].some(Boolean);
  queued.clear();
  return pollKeys(keys, explicit);
}

/** New targets are read together on the next microtask. */
function readSoon(key: string) {
  if (!queued.has(key)) queued.set(key, false);
  if (queuedFlush) return;
  queuedFlush = true;
  queueMicrotask(() => {
    queuedFlush = false;
    if (!inFlight) void flushQueued();
  });
}

async function probePublishedHead(key: string) {
  const target = targets.get(key);
  if (!target || document.visibilityState === "hidden") return;
  let head: string | null;
  try {
    const result = await commands.getWorktreePublishedHead(
      target.worktreePath,
      target.branch
    );
    if (result.status !== "ok") return;
    head = result.data;
  } catch {
    return;
  }
  if (targets.get(key) !== target) return;
  const previous = target.publishedHead;
  target.publishedHead = head;
  // The first probe only records where the branch was.
  if (previous === undefined || previous === head || head === null) return;
  if (entryOf(key).prNumber === null) return;
  target.awaitingPolls = 0;
  update(key, (current) => ({
    ...current,
    awaitingHead: current.snapshot?.headSha === head ? null : head,
  }));
  void pollKeys([key], false);
}

function onFocus() {
  if (document.visibilityState === "hidden") {
    clearTimer();
    return;
  }
  if (lastTickAt === null || Date.now() - lastTickAt >= FOCUS_MIN_AGE_MS)
    void pollWatchedWorktreePrsNow();
  else if (timer === null && !inFlight) scheduleNext();
}

/**
 * A user link, unlink or relink resets the entry and reads it at once. The
 * first association read only fills in what the first poll may still answer.
 */
function syncWithAssociations() {
  for (const [key, target] of targets) {
    const known = associationNumber(key);
    if (known === undefined || known === target.linkedAs) continue;
    const first = target.linkedAs === undefined;
    target.linkedAs = known;
    if (first && known === entryOf(key).prNumber) continue;
    if (first && (reading.has(key) || queued.has(key))) {
      update(key, (entry) => ({ ...entry, prNumber: known }));
      continue;
    }
    target.generation += 1;
    target.awaitingPolls = 0;
    target.failures = 0;
    update(key, () => ({ ...IDLE_CHECKS_ENTRY, prNumber: known }));
    if (known !== null) readSoon(key);
  }
}

function start() {
  if (!unsubscribeAssociations)
    unsubscribeAssociations =
      useWorktreePrStore.subscribe(syncWithAssociations);
  if (!focusListener) {
    focusListener = onFocus;
    window.addEventListener("focus", focusListener);
    document.addEventListener("visibilitychange", focusListener);
  }
}

function stopIfIdle() {
  if (targets.size > 0) return;
  clearTimer();
  unsubscribeAssociations?.();
  unsubscribeAssociations = null;
  if (focusListener) {
    window.removeEventListener("focus", focusListener);
    document.removeEventListener("visibilitychange", focusListener);
    focusListener = null;
  }
}

function addTarget(worktreePath: string, branch: string): [string, Target] {
  const key = worktreePrKey(worktreePath, branch);
  const existing = targets.get(key);
  if (existing) return [key, existing];
  const created: Target = {
    worktreePath,
    branch,
    consumers: 0,
    watched: false,
    generation: 0,
    linkedAs: undefined,
    probe: null,
    publishedHead: undefined,
    awaitingPolls: 0,
    failures: 0,
  };
  targets.set(key, created);
  start();
  const known = associationNumber(key);
  created.linkedAs = known;
  update(key, () => ({ ...IDLE_CHECKS_ENTRY, prNumber: known ?? null }));
  if (known !== null) readSoon(key);
  return [key, created];
}

function dropIfUnused(key: string, target: Target) {
  if (targets.get(key) !== target || target.consumers > 0 || target.watched)
    return;
  if (target.probe !== null) clearInterval(target.probe);
  targets.delete(key);
  queued.delete(key);
  useWorktreePrChecksStore.setState((state) => {
    if (!(key in state.entries)) return state;
    const entries = { ...state.entries };
    delete entries[key];
    return { entries };
  });
  stopIfIdle();
}

/**
 * Shows the linked PR's checks for a branch on screen: the branch joins the
 * poller and is probed locally for pushes. Release is deferred one microtask
 * so a Strict Mode remount keeps the entry.
 */
export function acquireWorktreePrChecks(
  worktreePath: string,
  branch: string
): () => void {
  const [key, target] = addTarget(worktreePath, branch);
  target.consumers += 1;
  if (target.probe === null) {
    target.probe = setInterval(
      () => void probePublishedHead(key),
      PUBLISHED_HEAD_PROBE_MS
    );
    void probePublishedHead(key);
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    target.consumers -= 1;
    queueMicrotask(() => {
      if (target.consumers > 0) return;
      if (target.probe !== null) clearInterval(target.probe);
      target.probe = null;
      dropIfUnused(key, target);
    });
  };
}

/**
 * Replaces the background set: the worktree branches of chats on unfinished
 * tickets. They are polled with the shown ones, without push probes.
 */
export function setWatchedPrWorktrees(next: readonly WorktreeBranch[]) {
  const wanted = new Set(
    next.map((target) => worktreePrKey(target.worktreePath, target.branch))
  );
  for (const [key, target] of [...targets]) {
    if (!target.watched || wanted.has(key)) continue;
    target.watched = false;
    dropIfUnused(key, target);
  }
  for (const target of next)
    addTarget(target.worktreePath, target.branch)[1].watched = true;
}

/** One background tick for every watched branch now, as focus does. */
export function pollWatchedWorktreePrsNow(): Promise<void> {
  return pollKeys([...targets.keys()], false);
}

export function refreshWorktreePrChecks(
  worktreePath: string,
  branch: string
): Promise<void> {
  const key = worktreePrKey(worktreePath, branch);
  if (!targets.has(key) || entryOf(key).prNumber === null)
    return Promise.resolve();
  return pollKeys([key], true);
}

/**
 * Sends one write to GitHub. The request is sent once: on any failure the
 * branch is read again so the user sees whether GitHub applied it anyway
 * before trying again.
 */
async function writeOnce(
  worktreePath: string,
  branch: string,
  field: "reruns" | "cancels",
  id: string,
  send: () => Promise<
    { status: "ok" } | { status: "error"; error: GithubFailure }
  >
): Promise<void> {
  const key = worktreePrKey(worktreePath, branch);
  const target = targets.get(key);
  const prNumber = entryOf(key).prNumber;
  if (!target || prNumber === null) return;
  if (entryOf(key)[field][id]?.status === "requesting") return;

  const set = (state: PrWriteState) =>
    update(key, (entry) =>
      entry.prNumber === prNumber
        ? { ...entry, [field]: { ...entry[field], [id]: state } }
        : entry
    );
  set({ status: "requesting" });
  let failure: GithubFailure | null = null;
  try {
    const result = await send();
    if (result.status === "error") failure = result.error;
  } catch (error) {
    failure = githubFailureOf(error);
  }
  if (targets.get(key) !== target) return;
  set(
    failure
      ? { status: "failed", message: failure.message }
      : { status: "requested", at: Date.now() }
  );
  await pollKeys([key], false);
}

/** Asks GitHub to re-run one failed Actions job. */
export function rerunWorktreePrCheck(
  worktreePath: string,
  branch: string,
  checkId: string
): Promise<void> {
  return writeOnce(worktreePath, branch, "reruns", checkId, () =>
    commands.rerunWorktreePrCheck(worktreePath, branch, checkId)
  );
}

/**
 * Asks GitHub to cancel the workflow run of a queued or running job; every
 * job of that run stops. Tracked by the run, which all its jobs share.
 */
export function cancelWorktreePrCheck(
  worktreePath: string,
  branch: string,
  checkId: string
): Promise<void> {
  const key = worktreePrKey(worktreePath, branch);
  const run = entryOf(key).snapshot?.checks.find(
    (check) => check.id === checkId
  )?.actionsRun;
  if (!run) return Promise.resolve();
  return writeOnce(worktreePath, branch, "cancels", run, () =>
    commands.cancelWorktreePrCheck(worktreePath, branch, checkId)
  );
}

export function linkedPrNumber(association: WorktreePrAssociation | null) {
  return linkedPullRequest(association)?.number ?? null;
}

export function resetWorktreePrChecksStore() {
  for (const target of targets.values())
    if (target.probe !== null) clearInterval(target.probe);
  targets.clear();
  reading.clear();
  queued.clear();
  queuedFlush = false;
  inFlight = null;
  lastTickAt = null;
  holdOffUntil = 0;
  stopIfIdle();
  useWorktreePrChecksStore.setState({ entries: {} });
}
