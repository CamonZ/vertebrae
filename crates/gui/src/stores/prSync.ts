import {
  commands,
  type GithubPrChecks,
  type GithubPrPollRequest,
  type GithubPullRequest,
  type GithubFailure,
  type GithubPrReviewThreads,
  type GithubThreadWrite,
  type Result,
  type Task,
  type WorktreeGithub,
} from "../bindings";
import { cachedTasksById } from "../query/cachedTasks";
import { queryClient } from "../query/queryClient";
import { isTaskDone } from "../utils/runState";
import { useChatStore } from "./chatStore";
import {
  chatBranchOf,
  chatPrLinkOf,
  isSameLinkedPr,
  isSamePr,
  linkedPrFrom,
  newerLink,
  remoteKey,
  sameLink,
  type BranchLink,
  type ChatPrLink,
  type LinkedPr,
} from "./prLinks";
import { createPrPoller, type PrPoller, type PrPollAnswer } from "./prPoller";
import { getProjectScopeGeneration } from "./projectScopedStores";
import {
  forgetThreadRead,
  readThreads,
  resetThreadReads,
} from "./prReviewThreadsSync";
import { resetReviewThreadNotices } from "./reviewThreadNotices";
import {
  GithubCommandError,
  IDLE_CHECKS,
  isPendingStatus,
  isPrBusy,
  onlyOwnPr,
  prEntryOf,
  prScope,
  reconcileWrites,
  settleGithubCommand,
  updatePrEntry as update,
  useWorktreePrStore,
  worktreePrKey,
  type GithubOutcome,
  type PrWriteState,
  type WorktreePrEntry,
} from "./worktreePrStore";

/**
 * Keeps each chat worktree branch's PR link (on the chats) and GitHub state
 * (in `useWorktreePrStore`) current. It decides what the poller watches:
 *
 * - a branch is watched while one of its chats' tickets is unfinished (by
 *   the tasks already cached; a ticket not in the cache counts as
 *   unfinished), or while it is on screen for a chat without a ticket;
 * - a watched branch with no link, or linked to an open (or not yet read)
 *   PR, asks for that PR and its checks and for the open PRs of the branch;
 * - a branch linked to a merged or closed PR asks for nothing of its own:
 *   its open PRs are listed only along with a remote watched anyway, which
 *   is how a newer PR for the branch shows up;
 * - an unlinked branch asks for nothing.
 *
 * A branch is read in full once each time it comes on screen and whenever
 * its link changes, unless the watch already reads it. Answers are matched
 * to branches by what they are about (the repository and PR number, or the
 * repository and branch), so a late answer for a PR the branch no longer
 * links changes nothing.
 */

/** Local-only probe of a shown branch's remote-tracking ref, to see a push. */
const PUBLISHED_HEAD_PROBE_MS = 10_000;
/** Reads spent waiting for GitHub to report a pushed head. */
const AWAITING_PUSH_MAX_POLLS = 10;

interface BranchState {
  key: string;
  worktreePath: string;
  branch: string;
  sessionIds: string[];
  link: BranchLink;
  watched: boolean;
}

/**
 * Finished and archived work stops polling. A ticket not in the cache (not
 * loaded yet, another project, deleted) keeps its PR watched.
 */
export function isWatchedEntity(task: Task | undefined): boolean {
  if (!task) return true;
  if (task.archived) return false;
  return !isTaskDone(task, task.run_controls?.active_run ?? null);
}

const OPEN_STATES = new Set([null, "open", "draft"]);

let poller: PrPoller | null = null;
let retained = 0;
/** Bumped by `resetPrSync`; releases from before it change nothing. */
let generation = 0;
let unsubscribers: (() => void)[] = [];
let syncPending = false;
const shown = new Map<string, number>();
/** Each watched branch's requests as last given to the poller. */
const watchedRequests = new Map<string, string>();
const probes = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; head: string | null | undefined }
>();
/** Branches to read in full once their remotes are known. */
const readOnce = new Set<string>();
const resolving = new Map<string, Promise<boolean>>();

function branchStates(): Map<string, BranchState> {
  const tasks = cachedTasksById(getProjectScopeGeneration());
  const states = new Map<string, BranchState>();
  const hasNoTicket = new Set<string>();
  for (const [id, session] of Object.entries(
    useChatStore.getState().sessions
  )) {
    const at = chatBranchOf(session);
    if (!at) continue;
    const key = worktreePrKey(at.worktreePath, at.branch);
    const state = states.get(key) ?? {
      key,
      ...at,
      sessionIds: [],
      link: undefined,
      watched: false,
    };
    state.sessionIds.push(id);
    state.link = newerLink(state.link, chatPrLinkOf(session));
    const ticketId = (session.association as { ticketId?: unknown } | null)
      ?.ticketId;
    if (typeof ticketId === "string")
      state.watched ||= isWatchedEntity(tasks.get(ticketId));
    else hasNoTicket.add(key);
    states.set(key, state);
  }
  for (const key of hasNoTicket) {
    const state = states.get(key);
    if (state && shown.has(key)) state.watched = true;
  }
  return states;
}

function stateOf(worktreePath: string, branch: string): BranchState {
  const key = worktreePrKey(worktreePath, branch);
  return (
    branchStates().get(key) ?? {
      key,
      worktreePath,
      branch,
      sessionIds: [],
      link: undefined,
      watched: false,
    }
  );
}

/** The newest link among the chats on the branch, as the sync will see it. */
export function branchLinkOf(worktreePath: string, branch: string): BranchLink {
  return stateOf(worktreePath, branch).link;
}

const prRequest = (pr: LinkedPr): GithubPrPollRequest => ({
  host: pr.host,
  repo: `${pr.owner}/${pr.repo}`,
  branches: [],
  numbers: [pr.number],
});

function listRequests(
  state: BranchState,
  github: Extract<WorktreeGithub, { status: "github" }>
): GithubPrPollRequest[] {
  return github.searchRepos.map((repo) => ({
    host: github.host,
    repo,
    branches: [state.branch],
    numbers: [],
  }));
}

/**
 * Everything about the branch: its linked PR in any state, and its open PRs
 * unless it was unlinked. Nothing until its GitHub remotes are known.
 */
function readRequests(state: BranchState): GithubPrPollRequest[] {
  const github = prEntryOf(state.key).github;
  if (github?.status !== "github") return [];
  const pr = state.link?.pr;
  if (state.link && !pr) return [];
  return [...(pr ? [prRequest(pr)] : []), ...listRequests(state, github)];
}

/** A watched branch's reads: polled, or listed only beside other reads. */
function watchRequests(state: BranchState): {
  polled: GithubPrPollRequest[];
  passive: GithubPrPollRequest[];
} {
  const requests = readRequests(state);
  const pr = state.link?.pr;
  return pr && !OPEN_STATES.has(pr.state)
    ? { polled: [], passive: requests.filter((r) => r.numbers.length === 0) }
    : { polled: requests, passive: [] };
}

const hasRequested = (writes: Readonly<Record<string, PrWriteState>>) =>
  Object.values(writes).some((state) => state.status === "requested");

/** Anything that needs the 30 s cadence: running CI or a settling change. */
function isActive(state: BranchState, entry: WorktreePrEntry): boolean {
  if (!state.link?.pr) return false;
  return (
    Boolean(
      entry.snapshot?.checks.some((check) => isPendingStatus(check.status))
    ) ||
    (entry.awaitingHead !== null &&
      entry.awaitingPolls < AWAITING_PUSH_MAX_POLLS) ||
    hasRequested(entry.reruns) ||
    hasRequested(entry.cancels)
  );
}

/** Resolves where the branch lives on GitHub; `false` when that failed. */
function resolve(worktreePath: string, branch: string): Promise<boolean> {
  const key = worktreePrKey(worktreePath, branch);
  const pending = resolving.get(key);
  if (pending) return pending;
  const at = prScope();
  const read = (async () => {
    const outcome = await settleGithubCommand(() =>
      commands.resolveWorktreeGithub(worktreePath, branch)
    );
    update(
      key,
      (entry) =>
        outcome.ok
          ? {
              ...entry,
              github: outcome.data,
              read: entry.read.status === "failed" ? IDLE_READ : entry.read,
            }
          : { ...entry, read: failedRead(outcome.failure, null, 1) },
      at
    );
    return outcome.ok;
  })().finally(() => {
    if (resolving.get(key) === read) resolving.delete(key);
  });
  resolving.set(key, read);
  return read;
}

const IDLE_READ = { status: "idle" } as const;

function failedRead(
  failure: GithubFailure,
  retryAt: number | null,
  attempt: number
): WorktreePrEntry["read"] {
  return { status: "failed", failure, retryAt, attempt };
}

/** Saves the link on every chat on the branch, and on its entry. */
function saveLink(state: BranchState, link: ChatPrLink) {
  const store = useChatStore.getState();
  for (const id of state.sessionIds) store.setSessionPrLink(id, link);
  state.link = link;
}

/** Sets a new link: the checks start over and the branch is read again. */
function writeLink(state: BranchState, pr: LinkedPr | null, now = Date.now()) {
  saveLink(state, {
    worktreePath: state.worktreePath,
    branch: state.branch,
    pr,
    changedAt: new Date(now).toISOString(),
  });
  update(state.key, (entry) => ({
    ...entry,
    ...IDLE_CHECKS,
    link: state.link,
    read: entry.read.status === "refreshing" ? entry.read : IDLE_READ,
    openPrs: {},
    error: null,
    newer: null,
  }));
  readOnce.add(state.key);
  scheduleSync();
}

/** Keeps what GitHub last said about the linked PR on the chats. */
function refreshLink(state: BranchState, fresh: LinkedPr) {
  const link = state.link;
  if (!link?.pr) return;
  const next: ChatPrLink = { ...link, pr: fresh };
  if (sameLink(next, link)) return;
  saveLink(state, next);
  update(state.key, (entry) => ({ ...entry, link: next }));
}

function sync() {
  const states = branchStates();
  const store = useChatStore.getState();
  const watch: GithubPrPollRequest[] = [];
  const passive: GithubPrPollRequest[] = [];
  let active = false;
  for (const state of states.values()) {
    const onScreen = shown.has(state.key);
    const tracked =
      state.watched ||
      onScreen ||
      state.key in useWorktreePrStore.getState().entries;
    if (!tracked) continue;
    let entry = prEntryOf(state.key);
    if (
      (state.watched || onScreen) &&
      !entry.github &&
      entry.read.status === "idle" &&
      !resolving.has(state.key)
    )
      void resolve(state.worktreePath, state.branch);
    // Every chat on a branch shares its newest link.
    if (state.link)
      for (const id of state.sessionIds) {
        const session = store.sessions[id];
        if (session && !sameLink(chatPrLinkOf(session), state.link))
          store.setSessionPrLink(id, state.link);
      }
    if (!sameLink(entry.link, state.link)) {
      const samePr = isSameLinkedPr(entry.link?.pr, state.link?.pr ?? null);
      if (!samePr) readOnce.add(state.key);
      update(state.key, (current) => ({
        ...current,
        ...(samePr ? {} : IDLE_CHECKS),
        link: state.link,
      }));
      entry = prEntryOf(state.key);
    }
    const { polled, passive: listed } = watchRequests(state);
    const asked = JSON.stringify(polled);
    // The poller reads a watched request as soon as it changes.
    const watchReads =
      state.watched &&
      polled.length > 0 &&
      watchedRequests.get(state.key) !== asked;
    if (state.watched) watchedRequests.set(state.key, asked);
    else watchedRequests.delete(state.key);
    if (state.watched) {
      watch.push(...polled);
      passive.push(...listed);
      active ||= isActive(state, entry);
    }
    if (onScreen && entry.github && readOnce.has(state.key)) {
      readOnce.delete(state.key);
      const once = readRequests(state);
      // A watched branch is read by the watch (now, if its request
      // changed), else by this read; either brings the threads.
      if (!(state.watched && polled.length > 0) && once.length > 0)
        void poller?.pollNow(once);
      else if (!watchReads) void readThreads(state, false);
    }
  }
  const watchedRemotes = new Set(watch.map((r) => remoteKey(r.host, r.repo)));
  watch.push(
    ...passive.filter((r) => watchedRemotes.has(remoteKey(r.host, r.repo)))
  );
  for (const key of watchedRequests.keys())
    if (!states.has(key)) watchedRequests.delete(key);
  for (const key of Object.keys(useWorktreePrStore.getState().entries))
    if (!states.has(key) && !shown.has(key)) evict(key);
  poller?.setWatch(watch, active);
}

function scheduleSync() {
  if (syncPending || !poller) return;
  syncPending = true;
  queueMicrotask(() => {
    syncPending = false;
    if (poller) sync();
  });
}

function evict(key: string) {
  readOnce.delete(key);
  useWorktreePrStore.setState((state) => {
    if (!(key in state.entries)) return state;
    const entries = { ...state.entries };
    delete entries[key];
    return { entries };
  });
}

function applyPr(
  state: BranchState,
  pr: GithubPullRequest,
  checks: GithubPrChecks,
  now: number
) {
  update(state.key, (entry) => {
    const caughtUp =
      entry.awaitingHead === null || checks.headSha === entry.awaitingHead;
    const polls = caughtUp ? 0 : entry.awaitingPolls + 1;
    const settled = caughtUp || polls >= AWAITING_PUSH_MAX_POLLS;
    return {
      ...entry,
      snapshot: checks,
      fetchedAt: now,
      // A refresh ends with its own read, not one that was already out.
      read: entry.read.status === "refreshing" ? entry.read : IDLE_READ,
      ...reconcileWrites(entry, checks, now),
      awaitingHead: settled ? null : entry.awaitingHead,
      awaitingPolls: settled ? 0 : polls,
    };
  });
  if (state.link?.pr) refreshLink(state, linkedPrFrom(state.link.pr.host, pr));
  // A refresh reads the threads itself, past the cache.
  if (shown.has(state.key) && prEntryOf(state.key).read.status !== "refreshing")
    void readThreads(state, false);
}

/**
 * Links the branch's only open PR when nothing is linked or the linked PR
 * was closed; after a merge it asks first.
 */
function decide(state: BranchState, now: number) {
  const entry = prEntryOf(state.key);
  const github = entry.github;
  if (github?.status !== "github") return;
  const linked = state.link?.pr;
  const only = onlyOwnPr(entry);
  if (!state.link) {
    if (only) writeLink(state, linkedPrFrom(github.host, only), now);
    return;
  }
  if (!linked || only?.number === linked.number) return;
  if (linked.state === "closed" && only)
    writeLink(state, linkedPrFrom(github.host, only), now);
  else if (linked.state === "merged") {
    const newer = only && only.number !== entry.dismissedNewer ? only : null;
    if (newer?.number !== entry.newer?.number)
      update(state.key, (current) => ({ ...current, newer }));
  }
}

function deliver({ requests, outcome, retries, now }: PrPollAnswer) {
  const states = [...branchStates().values()];
  const touched = new Set<BranchState>();
  const searches = (state: BranchState, host: string, repo: string) => {
    const github = prEntryOf(state.key).github;
    return github?.status === "github" &&
      github.host.toLowerCase() === host.toLowerCase()
      ? github.searchRepos.find(
          (name) => name.toLowerCase() === repo.toLowerCase()
        )
      : undefined;
  };
  const listed = (state: BranchState, host: string, repo: string) =>
    !!searches(state, host, repo) &&
    requests.some(
      (request) =>
        remoteKey(request.host, request.repo) === remoteKey(host, repo) &&
        request.branches.includes(state.branch)
    );
  // An unwatched branch is not read again on its own.
  const fail = (
    state: BranchState,
    failure: GithubFailure,
    host: string,
    repo: string
  ) => {
    const retry = retries.get(remoteKey(host, repo));
    update(state.key, (entry) => ({
      ...entry,
      read: failedRead(
        failure,
        state.watched ? (retry?.retryAt ?? null) : null,
        retry?.attempt ?? 1
      ),
    }));
  };

  if (!outcome.ok) {
    for (const request of requests)
      for (const state of states) {
        const pr = state.link?.pr;
        const about = pr
          ? request.numbers.some((n) =>
              isSamePr(pr, request.host, request.repo, n)
            )
          : listed(state, request.host, request.repo);
        if (about) fail(state, outcome.failure, request.host, request.repo);
      }
    return;
  }

  for (const remote of outcome.data.remotes) {
    for (const polled of remote.pullRequests)
      for (const state of states) {
        const pr = state.link?.pr;
        if (!pr || !isSamePr(pr, remote.host, remote.repo, polled.number))
          continue;
        if (polled.result.status === "read")
          applyPr(state, polled.result.pr, polled.result.checks, now);
        else fail(state, polled.result.failure, remote.host, remote.repo);
      }
    const open = remote.openPrs;
    if (open.status === "not_requested") continue;
    for (const state of states) {
      if (!listed(state, remote.host, remote.repo)) continue;
      // A linked branch's read is its PR's; its open PRs only offer a newer one.
      const linked = !!state.link?.pr;
      if (open.status === "failed") {
        if (!linked) fail(state, open.failure, remote.host, remote.repo);
        continue;
      }
      const found = open.branches.find(
        (branch) => branch.branch === state.branch
      );
      const repo = searches(state, remote.host, remote.repo);
      if (!found || !repo) continue;
      update(state.key, (entry) => ({
        ...entry,
        openPrs: {
          ...entry.openPrs,
          [repo]: { prs: found.prs, complete: found.complete },
        },
        read:
          linked || entry.read.status === "refreshing" ? entry.read : IDLE_READ,
      }));
      touched.add(state);
    }
  }
  for (const state of touched) decide(state, now);
}

function stop() {
  poller?.dispose();
  poller = null;
  // A new poller starts with nothing watched.
  watchedRequests.clear();
  for (const unsubscribe of unsubscribers) unsubscribe();
  unsubscribers = [];
}

/** Keeps the sync running while retained (the app shell, a bar on screen). */
export function retainPrSync(): () => void {
  retained += 1;
  if (!poller) {
    poller = createPrPoller({
      read: (requests) =>
        settleGithubCommand(() => commands.pollGithubPrs(requests)),
      deliver,
    });
    unsubscribers = [
      useChatStore.subscribe((state, previous) => {
        if (state.sessions !== previous.sessions) scheduleSync();
      }),
      useWorktreePrStore.subscribe(scheduleSync),
      queryClient.getQueryCache().subscribe(scheduleSync),
    ];
    scheduleSync();
  }
  const born = generation;
  let released = false;
  return () => {
    if (released || born !== generation) return;
    released = true;
    retained -= 1;
    queueMicrotask(() => {
      if (retained === 0) stop();
    });
  };
}

async function probePublishedHead(worktreePath: string, branch: string) {
  const key = worktreePrKey(worktreePath, branch);
  const probe = probes.get(key);
  if (!probe || document.visibilityState === "hidden") return;
  const result = await settleGithubCommand(() =>
    commands.getWorktreePublishedHead(worktreePath, branch)
  );
  if (!result.ok || probes.get(key) !== probe) return;
  const head = result.data;
  const previous = probe.head;
  probe.head = head;
  // The first probe only records where the branch was.
  if (previous === undefined || previous === head || head === null) return;
  const state = stateOf(worktreePath, branch);
  if (!state.link?.pr) return;
  update(key, (entry) => ({
    ...entry,
    awaitingHead: entry.snapshot?.headSha === head ? null : head,
    awaitingPolls: 0,
  }));
  void poller?.pollNow(readRequests(state));
}

/**
 * Shows a branch's PR: it is resolved and read (once each time it comes on
 * screen, unless watched), and probed locally for pushes. Release is
 * deferred one microtask so a Strict Mode remount keeps it.
 */
export function acquireWorktreePr(
  worktreePath: string,
  branch: string
): () => void {
  const key = worktreePrKey(worktreePath, branch);
  const release = retainPrSync();
  if (!shown.has(key)) readOnce.add(key);
  shown.set(key, (shown.get(key) ?? 0) + 1);
  if (!probes.has(key)) {
    probes.set(key, {
      timer: setInterval(
        () => void probePublishedHead(worktreePath, branch),
        PUBLISHED_HEAD_PROBE_MS
      ),
      head: undefined,
    });
    void probePublishedHead(worktreePath, branch);
  }
  scheduleSync();

  const born = generation;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    queueMicrotask(() => {
      if (born !== generation) return;
      const left = (shown.get(key) ?? 1) - 1;
      if (left > 0) shown.set(key, left);
      else {
        shown.delete(key);
        const probe = probes.get(key);
        if (probe) clearInterval(probe.timer);
        probes.delete(key);
      }
      scheduleSync();
      release();
    });
  };
}

/** Reads the branch again now: where it lives, its PR and checks, its open PRs. */
export async function refreshWorktreePr(
  worktreePath: string,
  branch: string
): Promise<boolean> {
  const key = worktreePrKey(worktreePath, branch);
  if (isPrBusy(prEntryOf(key))) return false;
  const at = prScope();
  update(key, (entry) => ({
    ...entry,
    read: { status: "refreshing" },
    error: null,
  }));
  resolving.delete(key);
  if (await resolve(worktreePath, branch)) {
    const state = stateOf(worktreePath, branch);
    await Promise.all([
      poller?.pollNow(readRequests(state)),
      readThreads(state, true),
    ]);
  }
  if (prScope() !== at) return false;
  const read = prEntryOf(key).read;
  if (read.status === "refreshing")
    update(key, (entry) => ({ ...entry, read: IDLE_READ }));
  return read.status !== "failed";
}

async function mutate(
  worktreePath: string,
  branch: string,
  run: (
    state: BranchState,
    host: string,
    current: () => boolean
  ) => Promise<GithubFailure | null>
): Promise<boolean> {
  const key = worktreePrKey(worktreePath, branch);
  if (isPrBusy(prEntryOf(key))) return false;
  const at = prScope();
  const current = () => prScope() === at;
  update(key, (entry) => ({ ...entry, linking: true, error: null }));
  if (!prEntryOf(key).github) await resolve(worktreePath, branch);
  const entry = prEntryOf(key);
  const github = entry.github;
  const failure =
    github?.status === "github"
      ? await run(stateOf(worktreePath, branch), github.host, current)
      : entry.read.status === "failed"
        ? entry.read.failure
        : {
            kind: "other" as const,
            message:
              github?.reason ??
              "GitHub repository unavailable for this worktree",
            retryAfterSecs: null,
          };
  update(key, (next) => ({ ...next, linking: false, error: failure }), at);
  return current() && failure === null;
}

/** Links PR `prNumber` in `repo` (a GitHub remote; the base repository by default). */
export function linkWorktreePr(
  worktreePath: string,
  branch: string,
  prNumber: number,
  repo: string | null
): Promise<boolean> {
  return mutate(worktreePath, branch, async (state, host, current) => {
    const outcome = await settleGithubCommand(() =>
      commands.getGithubPr(worktreePath, branch, repo, prNumber)
    );
    if (!outcome.ok) return outcome.failure;
    if (current()) writeLink(state, linkedPrFrom(host, outcome.data));
    return null;
  });
}

/** Unlinks the branch's PR; the branch is not linked automatically again. */
export function unlinkWorktreePr(
  worktreePath: string,
  branch: string
): Promise<boolean> {
  return mutate(worktreePath, branch, async (state) => {
    writeLink(state, null);
    return null;
  });
}

/** Links the newer PR offered after the linked one was merged. */
export function acceptNewerWorktreePr(
  worktreePath: string,
  branch: string
): Promise<boolean> {
  const newer = prEntryOf(worktreePrKey(worktreePath, branch)).newer;
  return mutate(worktreePath, branch, async (state, host) => {
    if (newer) writeLink(state, linkedPrFrom(host, newer));
    return null;
  });
}

export function dismissNewerWorktreePr(worktreePath: string, branch: string) {
  update(worktreePrKey(worktreePath, branch), (entry) => ({
    ...entry,
    newer: null,
    dismissedNewer: entry.newer?.number ?? entry.dismissedNewer,
  }));
}

export async function listWorktreeOpenPrs(
  worktreePath: string,
  branch: string
): Promise<GithubPullRequest[]> {
  const outcome = await settleGithubCommand(() =>
    commands.listGithubOpenPrs(worktreePath, branch, null)
  );
  if (outcome.ok) return outcome.data;
  throw new GithubCommandError(outcome.failure);
}

/**
 * Sends one write to GitHub. The request is sent once: on any failure the
 * PR is read again so the user sees whether GitHub applied it anyway.
 */
async function writeOnce(
  worktreePath: string,
  branch: string,
  field: "reruns" | "cancels",
  id: string,
  send: (pr: LinkedPr) => Promise<Result<null, GithubFailure>>
): Promise<void> {
  const state = stateOf(worktreePath, branch);
  const pr = state.link?.pr;
  const key = state.key;
  if (!pr || prEntryOf(key)[field][id]?.status === "requesting") return;
  const at = prScope();
  const set = (write: PrWriteState) =>
    update(
      key,
      (entry) =>
        isSameLinkedPr(entry.link?.pr, pr)
          ? { ...entry, [field]: { ...entry[field], [id]: write } }
          : entry,
      at
    );
  set({ status: "requesting" });
  const outcome = await settleGithubCommand(() => send(pr));
  set(
    outcome.ok
      ? { status: "requested", at: Date.now() }
      : { status: "failed", message: outcome.failure.message }
  );
  if (prScope() === at)
    await poller?.pollNow(readRequests(stateOf(worktreePath, branch)));
}

/** Asks GitHub to re-run one failed Actions job. */
export function rerunWorktreePrCheck(
  worktreePath: string,
  branch: string,
  checkId: string
): Promise<void> {
  return writeOnce(worktreePath, branch, "reruns", checkId, (pr) =>
    commands.rerunGithubPrCheck(
      worktreePath,
      branch,
      `${pr.owner}/${pr.repo}`,
      pr.number,
      checkId
    )
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
  const run = prEntryOf(
    worktreePrKey(worktreePath, branch)
  ).snapshot?.checks.find((check) => check.id === checkId)?.actionsRun;
  if (!run) return Promise.resolve();
  return writeOnce(worktreePath, branch, "cancels", run, (pr) =>
    commands.cancelGithubPrCheck(
      worktreePath,
      branch,
      `${pr.owner}/${pr.repo}`,
      pr.number,
      checkId
    )
  );
}

const NOT_LINKED: GithubFailure = {
  kind: "other",
  message: "The PR this was written for is no longer linked to the branch.",
  retryAfterSecs: null,
};

/**
 * Reads the linked PR `prNumber`'s threads past every cache. A read already
 * out started before what the caller needs to see, so it answers no one.
 * The threads as read, or null when the read failed or the PR changed.
 */
export async function rereadWorktreeReviewThreads(
  worktreePath: string,
  branch: string,
  prNumber: number
): Promise<GithubPrReviewThreads | null> {
  const state = stateOf(worktreePath, branch);
  if (state.link?.pr?.number !== prNumber) return null;
  forgetThreadRead(state.key);
  await readThreads(state, true);
  const { reviewThreads } = prEntryOf(state.key);
  return reviewThreads.error === null &&
    reviewThreads.data?.prNumber === prNumber
    ? reviewThreads.data
    : null;
}

/**
 * Posts one write to the review threads of the linked PR `prNumber`, the
 * PR the user saw as its target; a different linked PR refuses it. Sent
 * once: success or not, the threads are read again so the view shows what
 * GitHub has. Answers the written thread's ID.
 */
export async function writeWorktreeReviewThread(
  worktreePath: string,
  branch: string,
  prNumber: number,
  write: GithubThreadWrite
): Promise<GithubOutcome<string>> {
  const pr = stateOf(worktreePath, branch).link?.pr;
  if (pr?.number !== prNumber) return { ok: false, failure: NOT_LINKED };
  const outcome = await settleGithubCommand(() =>
    commands.writeGithubPrReviewThread(
      worktreePath,
      branch,
      `${pr.owner}/${pr.repo}`,
      pr.number,
      write
    )
  );
  await rereadWorktreeReviewThreads(worktreePath, branch, prNumber);
  return outcome;
}

/** Makes every watched remote due, as a timer tick would. */
export function pollWatchedPrsNow(): Promise<void> {
  return poller?.pollNow() ?? Promise.resolve();
}

/**
 * Stops the sync and clears every branch (tests). A project switch clears
 * only the entries (`resetProjectScopedStores`): the poller's hold-off is
 * GitHub's account-wide rate limit, and resetting the chats empties the
 * watch list.
 */
export function resetPrSync() {
  generation += 1;
  stop();
  retained = 0;
  syncPending = false;
  for (const probe of probes.values()) clearInterval(probe.timer);
  probes.clear();
  shown.clear();
  readOnce.clear();
  resolving.clear();
  resetThreadReads();
  watchedRequests.clear();
  resetReviewThreadNotices();
  useWorktreePrStore.getState().reset();
}
