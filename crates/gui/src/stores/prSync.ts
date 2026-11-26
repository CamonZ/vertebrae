import {
  commands,
  type GithubPrChecks,
  type GithubPrPollRequest,
  type GithubPullRequest,
  type GithubFailure,
  type Result,
  type Task,
} from "../bindings";
import { cachedTasksById } from "../query/cachedTasks";
import { queryClient } from "../query/queryClient";
import { isTaskDone } from "../utils/runState";
import { useChatStore } from "./chatStore";
import {
  chatBranchOf,
  chatPrLinkOf,
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
  AWAITING_PUSH_MAX_POLLS,
  IDLE_CHECKS_ENTRY,
  PUBLISHED_HEAD_PROBE_MS,
  isPendingStatus,
  reconcileWrites,
  type PrWriteState,
} from "./worktreePrChecksStore";
import {
  GithubCommandError,
  IDLE_PR_ENTRY,
  isPrBusy,
  onlyOwnPr,
  prEntryOf,
  settleGithubCommand,
  useWorktreePrStore,
  worktreePrKey,
  type WorktreePrEntry,
} from "./worktreePrStore";

/**
 * Keeps each chat worktree branch's PR link (on the chats) and GitHub state
 * (in `useWorktreePrStore`) current. It decides what the poller watches:
 *
 * - a branch is watched while one of its chats' tickets is unfinished (by
 *   the tasks already cached; a ticket not in the cache counts as
 *   unfinished), or while it is on screen for a chat without a ticket;
 * - a branch linked to an open (or not yet read) PR asks for that PR and
 *   its checks;
 * - a branch with no link, or linked to a merged or closed PR, asks for the
 *   open PRs of the branch; an unlinked branch asks for nothing.
 *
 * A branch on screen that is not watched is read once per app session.
 * Answers are matched to branches by what they are about (the repository
 * and PR number, or the repository and branch), so a late answer for a PR
 * the branch no longer links changes nothing.
 */

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
const probes = new Map<
  string,
  { timer: ReturnType<typeof setInterval>; head: string | null | undefined }
>();
const awaitingPolls = new Map<string, number>();
const checkedOnce = new Set<string>();
const resolving = new Map<string, Promise<void>>();

function update(
  key: string,
  next: (entry: WorktreePrEntry) => WorktreePrEntry
) {
  useWorktreePrStore.setState((state) => ({
    entries: {
      ...state.entries,
      [key]: next(state.entries[key] ?? IDLE_PR_ENTRY),
    },
  }));
}

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

/** What to read for one branch; nothing until its GitHub remotes are known. */
function branchRequests(state: BranchState): GithubPrPollRequest[] {
  const github = prEntryOf(state.key).github;
  if (github?.status !== "github") return [];
  const requests: GithubPrPollRequest[] = [];
  const pr = state.link?.pr;
  if (pr && OPEN_STATES.has(pr.state))
    requests.push({
      host: pr.host,
      repo: `${pr.owner}/${pr.repo}`,
      branches: [],
      numbers: [pr.number],
    });
  if (!state.link || (pr && !OPEN_STATES.has(pr.state)))
    for (const repo of github.searchRepos)
      requests.push({
        host: github.host,
        repo,
        branches: [state.branch],
        numbers: [],
      });
  return requests;
}

const hasRequested = (writes: Readonly<Record<string, PrWriteState>>) =>
  Object.values(writes).some((state) => state.status === "requested");

/** Anything that needs the 30 s cadence: running CI or a settling change. */
function isActive(state: BranchState): boolean {
  if (!state.link?.pr) return false;
  const entry = prEntryOf(state.key);
  return (
    Boolean(
      entry.snapshot?.checks.some((check) => isPendingStatus(check.status))
    ) ||
    (entry.awaitingHead !== null &&
      (awaitingPolls.get(state.key) ?? 0) < AWAITING_PUSH_MAX_POLLS) ||
    hasRequested(entry.reruns) ||
    hasRequested(entry.cancels)
  );
}

function resolve(worktreePath: string, branch: string): Promise<void> {
  const key = worktreePrKey(worktreePath, branch);
  const pending = resolving.get(key);
  if (pending) return pending;
  const read = (async () => {
    const outcome = await settleGithubCommand(() =>
      commands.resolveWorktreeGithub(worktreePath, branch)
    );
    update(key, (entry) =>
      outcome.ok
        ? { ...entry, github: outcome.data, lookupFailure: null }
        : { ...entry, lookupFailure: outcome.failure }
    );
  })().finally(() => resolving.delete(key));
  resolving.set(key, read);
  return read;
}

/** Writes the link to every chat on the branch. */
function writeLink(state: BranchState, pr: LinkedPr | null, now = Date.now()) {
  const link: ChatPrLink = {
    worktreePath: state.worktreePath,
    branch: state.branch,
    pr,
    changedAt: new Date(now).toISOString(),
  };
  const store = useChatStore.getState();
  for (const id of state.sessionIds) store.setSessionPrLink(id, link);
  state.link = link;
  awaitingPolls.delete(state.key);
  update(state.key, (entry) => ({
    ...entry,
    ...IDLE_CHECKS_ENTRY,
    prNumber: pr?.number ?? null,
    openPrs: {},
    openFailure: null,
    error: null,
    newer: null,
  }));
}

/** Keeps what GitHub last said about the linked PR on the chats. */
function refreshLink(state: BranchState, fresh: LinkedPr) {
  const link = state.link;
  if (!link?.pr) return;
  const next: ChatPrLink = { ...link, pr: fresh };
  if (sameLink(next, link)) return;
  const store = useChatStore.getState();
  for (const id of state.sessionIds) store.setSessionPrLink(id, next);
  state.link = next;
}

function sync() {
  const states = branchStates();
  const store = useChatStore.getState();
  const watch: GithubPrPollRequest[] = [];
  let active = false;
  for (const state of states.values()) {
    const entry = prEntryOf(state.key);
    const onScreen = shown.has(state.key);
    if (
      (state.watched || onScreen) &&
      !entry.github &&
      !entry.lookupFailure &&
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
    const number = state.link?.pr?.number ?? null;
    if (entry.prNumber !== number && entry !== IDLE_PR_ENTRY)
      update(state.key, (current) => ({
        ...current,
        ...IDLE_CHECKS_ENTRY,
        prNumber: number,
      }));
    if (state.watched) {
      watch.push(...branchRequests(state));
      active ||= isActive(state);
    } else if (onScreen && entry.github && !checkedOnce.has(state.key)) {
      checkedOnce.add(state.key);
      const once = branchRequests(state);
      if (once.length > 0) void poller?.pollNow(once);
    }
  }
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
  awaitingPolls.delete(key);
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
  const key = state.key;
  const awaiting = prEntryOf(key).awaitingHead;
  const caughtUp = awaiting === null || checks.headSha === awaiting;
  let polls = awaitingPolls.get(key) ?? 0;
  if (!caughtUp) polls += 1;
  const settled = caughtUp || polls >= AWAITING_PUSH_MAX_POLLS;
  awaitingPolls.set(key, settled ? 0 : polls);
  update(key, (entry) => ({
    ...entry,
    prNumber: pr.number,
    pr,
    snapshot: checks,
    fetchedAt: now,
    refresh: { status: "idle" },
    ...reconcileWrites(entry, checks, now),
    awaitingHead: settled ? null : entry.awaitingHead,
  }));
  if (state.link?.pr) refreshLink(state, linkedPrFrom(state.link.pr.host, pr));
}

function failPr(
  state: BranchState,
  failure: GithubFailure,
  retry: { attempt: number; retryAt: number | null } | undefined
) {
  update(state.key, (entry) => ({
    ...entry,
    refresh: {
      status: "failed",
      failure,
      retryAt: retry?.retryAt ?? null,
      attempt: retry?.attempt ?? 1,
    },
  }));
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

  if (!outcome.ok) {
    for (const request of requests) {
      const retry = retries.get(remoteKey(request.host, request.repo));
      for (const state of states) {
        const pr = state.link?.pr;
        if (
          pr &&
          request.numbers.some((n) =>
            isSamePr(pr, request.host, request.repo, n)
          )
        )
          failPr(state, outcome.failure, retry);
        if (
          request.branches.includes(state.branch) &&
          searches(state, request.host, request.repo)
        )
          update(state.key, (entry) => ({
            ...entry,
            openFailure: outcome.failure,
          }));
      }
    }
    return;
  }

  for (const remote of outcome.data.remotes) {
    const retry = retries.get(remoteKey(remote.host, remote.repo));
    for (const polled of remote.pullRequests)
      for (const state of states) {
        const pr = state.link?.pr;
        if (!pr || !isSamePr(pr, remote.host, remote.repo, polled.number))
          continue;
        if (polled.result.status === "read")
          applyPr(state, polled.result.pr, polled.result.checks, now);
        else failPr(state, polled.result.failure, retry);
      }
    const open = remote.openPrs;
    if (open.status === "not_requested") continue;
    for (const state of states) {
      const repo = searches(state, remote.host, remote.repo);
      if (!repo) continue;
      if (open.status === "failed") {
        const asked = requests.some(
          (request) =>
            remoteKey(request.host, request.repo) ===
              remoteKey(remote.host, remote.repo) &&
            request.branches.includes(state.branch)
        );
        if (asked)
          update(state.key, (entry) => ({
            ...entry,
            openFailure: open.failure,
          }));
        continue;
      }
      const found = open.branches.find(
        (branch) => branch.branch === state.branch
      );
      if (!found) continue;
      update(state.key, (entry) => ({
        ...entry,
        openPrs: {
          ...entry.openPrs,
          [repo]: { prs: found.prs, complete: found.complete },
        },
        openFailure: null,
      }));
      touched.add(state);
    }
  }
  for (const state of touched) decide(state, now);
}

function stop() {
  poller?.dispose();
  poller = null;
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
  awaitingPolls.set(key, 0);
  update(key, (entry) => ({
    ...entry,
    awaitingHead: entry.snapshot?.headSha === head ? null : head,
  }));
  void poller?.pollNow(branchRequests(state));
}

/**
 * Shows a branch's PR: it is resolved and read (once, unless watched), and
 * probed locally for pushes. Release is deferred one microtask so a Strict
 * Mode remount keeps it.
 */
export function acquireWorktreePr(
  worktreePath: string,
  branch: string
): () => void {
  const key = worktreePrKey(worktreePath, branch);
  const release = retainPrSync();
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
  const entry = prEntryOf(key);
  // A failed lookup waits for Check again.
  if (!entry.github && !entry.lookupFailure) void resolve(worktreePath, branch);
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

/** Reads the branch again now: where it lives, its PR and checks or its open PRs. */
export async function refreshWorktreePr(
  worktreePath: string,
  branch: string
): Promise<boolean> {
  const key = worktreePrKey(worktreePath, branch);
  if (isPrBusy(prEntryOf(key).phase)) return false;
  update(key, (entry) => ({
    ...entry,
    phase: "refreshing",
    error: null,
    refresh: entry.prNumber !== null ? { status: "refreshing" } : entry.refresh,
  }));
  resolving.delete(key);
  await resolve(worktreePath, branch);
  const requests = branchRequests(stateOf(worktreePath, branch));
  await poller?.pollNow(requests, { explicit: true });
  const entry = prEntryOf(key);
  const failure =
    entry.lookupFailure ??
    (entry.refresh.status === "failed" ? entry.refresh.failure : null) ??
    entry.openFailure;
  update(key, (current) => ({
    ...current,
    phase: "ready",
    refresh:
      current.refresh.status === "refreshing"
        ? { status: "idle" }
        : current.refresh,
  }));
  return failure === null;
}

async function mutate(
  worktreePath: string,
  branch: string,
  run: (state: BranchState, host: string) => Promise<GithubFailure | null>
): Promise<boolean> {
  const key = worktreePrKey(worktreePath, branch);
  if (isPrBusy(prEntryOf(key).phase)) return false;
  update(key, (entry) => ({ ...entry, phase: "mutating", error: null }));
  if (!prEntryOf(key).github) await resolve(worktreePath, branch);
  const github = prEntryOf(key).github;
  const failure =
    github?.status === "github"
      ? await run(stateOf(worktreePath, branch), github.host)
      : (prEntryOf(key).lookupFailure ?? {
          kind: "other" as const,
          message:
            github?.reason ?? "GitHub repository unavailable for this worktree",
          retryAfterSecs: null,
        });
  update(key, (entry) => ({ ...entry, phase: "ready", error: failure }));
  return failure === null;
}

/** Links PR `prNumber` in `repo` (a GitHub remote; the base repository by default). */
export function linkWorktreePr(
  worktreePath: string,
  branch: string,
  prNumber: number,
  repo: string | null
): Promise<boolean> {
  return mutate(worktreePath, branch, async (state, host) => {
    const outcome = await settleGithubCommand(() =>
      commands.getGithubPr(worktreePath, branch, repo, prNumber)
    );
    if (!outcome.ok) return outcome.failure;
    writeLink(state, linkedPrFrom(host, outcome.data));
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
  const set = (write: PrWriteState) =>
    update(key, (entry) =>
      entry.prNumber === pr.number
        ? { ...entry, [field]: { ...entry[field], [id]: write } }
        : entry
    );
  set({ status: "requesting" });
  const outcome = await settleGithubCommand(() => send(pr));
  set(
    outcome.ok
      ? { status: "requested", at: Date.now() }
      : { status: "failed", message: outcome.failure.message }
  );
  await poller?.pollNow(branchRequests(stateOf(worktreePath, branch)));
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

/** Reads every watched remote not backing off, as a timer tick would. */
export function pollWatchedPrsNow(): Promise<void> {
  return poller?.pollNow() ?? Promise.resolve();
}

/**
 * Not part of `resetProjectScopedStores`: entries are keyed by worktree and
 * branch, and the poller's hold-off is GitHub's account-wide rate limit. A
 * project switch resets the chats, which empties the watch list. Tests
 * reset everything here.
 */
export function resetPrSync() {
  generation += 1;
  stop();
  retained = 0;
  syncPending = false;
  for (const probe of probes.values()) clearInterval(probe.timer);
  probes.clear();
  shown.clear();
  awaitingPolls.clear();
  checkedOnce.clear();
  resolving.clear();
  useWorktreePrStore.setState({ entries: {} });
}
