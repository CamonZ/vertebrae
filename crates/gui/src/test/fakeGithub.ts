import { act } from "@testing-library/react";
import { vi } from "vitest";
import type {
  GithubFailure,
  GithubPrCheck,
  GithubPrChecks,
  GithubPrPollRequest,
  GithubPullRequest,
  GithubRemotePoll,
  GithubReviewThread,
  GithubThreadWrite,
  WorktreeGithub,
  commands as Commands,
} from "../bindings";
import { useChatStore, type ChatSession } from "../stores/chatStore";
import type { ChatPrLink, LinkedPr } from "../stores/prLinks";
import { resetPrSync } from "../stores/prSync";
import { applyThreadWrite } from "../components/ChatWindow/workspace/githubReview/fixture";

/**
 * A synthetic GitHub behind the GitHub commands the PR sync calls, so tests
 * drive the real sync, poller and stores. Repositories and people are made
 * up (`example/demo-repo`, `alice`).
 */

export const HOST = "github.com";
export const REPO = "example/demo-repo";

type GithubCommands = Pick<
  typeof Commands,
  | "resolveWorktreeGithub"
  | "pollGithubPrs"
  | "listGithubOpenPrs"
  | "getGithubPr"
  | "rerunGithubPrCheck"
  | "cancelGithubPrCheck"
  | "getWorktreePublishedHead"
> &
  Partial<
    Pick<
      typeof Commands,
      "getGithubPrReviewThreads" | "writeGithubPrReviewThread"
    >
  >;

export const GITHUB_COMMANDS = [
  "resolveWorktreeGithub",
  "pollGithubPrs",
  "listGithubOpenPrs",
  "getGithubPr",
  "rerunGithubPrCheck",
  "cancelGithubPrCheck",
  "getWorktreePublishedHead",
  "getGithubPrReviewThreads",
  "writeGithubPrReviewThread",
] as const;

export function pullRequest(
  number: number,
  overrides: Partial<GithubPullRequest> = {}
): GithubPullRequest {
  return {
    owner: "example",
    repo: "demo-repo",
    number,
    title: `PR title ${number}`,
    state: "open",
    headRef: "feature/retry",
    headRepo: REPO,
    baseRef: "main",
    url: `https://github.com/${REPO}/pull/${number}`,
    author: "alice",
    updatedAt: "2026-11-24T12:00:00Z",
    ...overrides,
  };
}

export function check(
  id: string,
  overrides: Partial<GithubPrCheck> = {}
): GithubPrCheck {
  return {
    id,
    name: id,
    provider: "github_actions",
    status: "passed",
    outcome: "success",
    startedAt: "2026-11-24T12:00:00Z",
    completedAt: "2026-11-24T12:05:00Z",
    url: `https://github.com/${REPO}/actions/runs/1/job/${id}`,
    summary: null,
    failedStep: null,
    actionsJob: true,
    actionsRun: "run-1",
    rerun: "not_applicable",
    cancel: "not_applicable",
    ...overrides,
  };
}

export function github(
  branch: string,
  overrides: Partial<Extract<WorktreeGithub, { status: "github" }>> = {}
): WorktreeGithub {
  return {
    status: "github",
    branch,
    host: HOST,
    headRepo: REPO,
    baseRepo: REPO,
    searchRepos: [REPO],
    createPrUrl: `https://github.com/${REPO}/compare/${encodeURIComponent(branch)}?expand=1`,
    ...overrides,
  };
}

export const failure = (
  kind: GithubFailure["kind"],
  message = `${kind} failure`,
  retryAfterSecs: number | null = null
): GithubFailure => ({ kind, message, retryAfterSecs });

const ok = <T>(data: T) => ({ status: "ok" as const, data });
const err = (error: GithubFailure) => ({ status: "error" as const, error });

export interface FakeGithub {
  /** How each worktree resolves; unknown worktrees resolve to `github(branch)`. */
  worktrees: Map<string, WorktreeGithub | GithubFailure>;
  /** Every PR GitHub knows, by `owner/name#number`. */
  prs: Map<string, GithubPullRequest>;
  /** Checks by `owner/name#number`; a PR without an entry has none. */
  checks: Map<string, GithubPrChecks>;
  /** Fails every read of a remote (`owner/name`) until cleared. */
  failRemote: Map<string, GithubFailure>;
  /** Fails a whole poll before it reaches GitHub. */
  failPoll: GithubFailure | null;
  publishedHead: string | null;
  headSha: string;
  /** Branches whose open-PR list GitHub cuts short. */
  incomplete: Set<string>;
  /** Review threads by `owner/name#number`; a PR without an entry has none. */
  reviewThreads: Map<string, GithubReviewThread[]>;
  /** Fails every review-thread read until cleared. */
  failThreads: GithubFailure | null;
  /** The signed-in user, who authors replies and new threads. */
  viewer: string | null;
  /** Every thread write GitHub received, in order. */
  writes: GithubThreadWrite[];
  /**
   * How the next writes answer, in order: a failure, and whether GitHub
   * applied the write anyway (a timeout that landed). Empty: they succeed.
   */
  writeOutcomes: { failure: GithubFailure; applied: boolean }[];
}

export const prId = (repo: string, number: number) =>
  `${repo}#${number}`.toLowerCase();

/** The synthetic GitHub node ID of PR `number` in `repo`. */
export const pullRequestNodeId = (repo: string, number: number) =>
  `PR_${repo.replace(/[^A-Za-z0-9]/g, "_")}_${number}`;

export function fakeGithub(): FakeGithub {
  return {
    worktrees: new Map(),
    prs: new Map(),
    checks: new Map(),
    failRemote: new Map(),
    failPoll: null,
    publishedHead: null,
    headSha: "abc1234",
    incomplete: new Set(),
    reviewThreads: new Map(),
    failThreads: null,
    viewer: "octo-viewer",
    writes: [],
    writeOutcomes: [],
  };
}

export function addPr(
  world: FakeGithub,
  pr: GithubPullRequest,
  checks: GithubPrCheck[] = []
) {
  const repo = `${pr.owner}/${pr.repo}`;
  world.prs.set(prId(repo, pr.number), pr);
  world.checks.set(prId(repo, pr.number), {
    prNumber: pr.number,
    repo,
    headSha: world.headSha,
    checks,
    truncated: false,
  });
}

function pollRemote(
  world: FakeGithub,
  request: GithubPrPollRequest
): GithubRemotePoll {
  const failed = world.failRemote.get(request.repo.toLowerCase());
  const inRepo = (pr: GithubPullRequest) =>
    `${pr.owner}/${pr.repo}`.toLowerCase() === request.repo.toLowerCase();
  return {
    host: request.host,
    repo: request.repo,
    openPrs:
      request.branches.length === 0
        ? { status: "not_requested" }
        : failed
          ? { status: "failed", failure: failed }
          : {
              status: "read",
              branches: request.branches.map((branch) => ({
                branch,
                prs: [...world.prs.values()].filter(
                  (pr) =>
                    inRepo(pr) &&
                    pr.headRef === branch &&
                    (pr.state === "open" || pr.state === "draft")
                ),
                complete: !world.incomplete.has(branch),
              })),
            },
    pullRequests: request.numbers.map((number) => {
      const pr = world.prs.get(prId(request.repo, number));
      if (failed || !pr)
        return {
          number,
          result: {
            status: "failed" as const,
            failure: failed ?? failure("not_found", `PR #${number} not found`),
          },
        };
      return {
        number,
        result: {
          status: "read" as const,
          pr,
          checks: world.checks.get(prId(request.repo, number))!,
        },
      };
    }),
  };
}

/** Points the mocked GitHub commands at `world`. */
export function installFakeGithub(commands: GithubCommands, world: FakeGithub) {
  const resolve = (worktreePath: string, branch: string) => {
    const found = world.worktrees.get(worktreePath) ?? github(branch);
    return "kind" in found ? err(found) : ok(found);
  };
  vi.mocked(commands.resolveWorktreeGithub).mockImplementation(
    async (worktreePath, branch) => resolve(worktreePath, branch)
  );
  vi.mocked(commands.pollGithubPrs).mockImplementation(async (requests) =>
    world.failPoll
      ? err(world.failPoll)
      : ok({
          remotes: requests.map((request) => pollRemote(world, request)),
          holdOffSecs: null,
        })
  );
  vi.mocked(commands.listGithubOpenPrs).mockImplementation(
    async (worktreePath, branch, repo) => {
      const at = resolve(worktreePath, branch);
      if (at.status === "error") return at;
      if (at.data.status !== "github")
        return err(failure("other", at.data.reason));
      const name = repo ?? at.data.baseRepo;
      const failed = world.failRemote.get(name.toLowerCase());
      if (failed) return err(failed);
      return ok(
        [...world.prs.values()].filter(
          (pr) =>
            `${pr.owner}/${pr.repo}`.toLowerCase() === name.toLowerCase() &&
            (pr.state === "open" || pr.state === "draft")
        )
      );
    }
  );
  vi.mocked(commands.getGithubPr).mockImplementation(
    async (worktreePath, branch, repo, number) => {
      const at = resolve(worktreePath, branch);
      if (at.status === "error") return at;
      if (at.data.status !== "github")
        return err(failure("other", at.data.reason));
      const name = repo ?? at.data.baseRepo;
      const failed = world.failRemote.get(name.toLowerCase());
      if (failed) return err(failed);
      const pr = world.prs.get(prId(name, number));
      return pr
        ? ok(pr)
        : err(failure("not_found", `PR #${number} was not found in ${name}`));
    }
  );
  vi.mocked(commands.rerunGithubPrCheck).mockResolvedValue(ok(null));
  vi.mocked(commands.cancelGithubPrCheck).mockResolvedValue(ok(null));
  vi.mocked(commands.getWorktreePublishedHead).mockImplementation(async () =>
    ok(world.publishedHead)
  );
  if (commands.getGithubPrReviewThreads)
    vi.mocked(commands.getGithubPrReviewThreads).mockImplementation(
      async (_worktreePath, _branch, repo, prNumber) =>
        world.failThreads
          ? err(world.failThreads)
          : ok({
              repo,
              prNumber,
              pullRequestId: pullRequestNodeId(repo, prNumber),
              headOid: "1".repeat(40),
              baseOid: "2".repeat(40),
              threads: world.reviewThreads.get(prId(repo, prNumber)) ?? [],
              truncated: false,
              viewerLogin: world.viewer,
            })
    );
  if (commands.writeGithubPrReviewThread)
    vi.mocked(commands.writeGithubPrReviewThread).mockImplementation(
      async (_worktreePath, _branch, repo, prNumber, write) => {
        world.writes.push(write);
        const outcome = world.writeOutcomes.shift();
        const id = prId(repo, prNumber);
        const nodeId = `PRRT_written_${world.writes.length}`;
        // A new thread goes to the PR node its write names, as on GitHub.
        if (
          write.kind === "start" &&
          write.pullRequestId !== pullRequestNodeId(repo, prNumber)
        )
          return err(failure("not_found", "No pull request with that node ID"));
        if (!outcome || outcome.applied)
          world.reviewThreads.set(
            id,
            applyThreadWrite(
              world.reviewThreads.get(id) ?? [],
              write,
              world.viewer ?? "octo-viewer",
              nodeId
            )
          );
        if (outcome) return err(outcome.failure);
        return ok(write.kind === "start" ? nodeId : write.threadId);
      }
    );
}

export function linkedPr(
  pr: GithubPullRequest,
  overrides: Partial<LinkedPr> = {}
): LinkedPr {
  return {
    host: HOST,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
    ...overrides,
  };
}

export function prLink(
  worktreePath: string,
  branch: string,
  pr: LinkedPr | null,
  changedAt: string | null = "2026-11-24T12:00:00.000Z"
): ChatPrLink {
  return { worktreePath, branch, pr, changedAt };
}

/** A chat associated with a worktree branch (and a ticket, unless `null`). */
export function chatSession(
  id: string,
  worktreePath: string,
  branch: string,
  {
    ticketId = `${id}-ticket`,
    link,
    ...association
  }: {
    ticketId?: string | null;
    link?: ChatPrLink;
    [key: string]: unknown;
  } = {}
): ChatSession {
  return {
    id,
    label: id,
    messages: [],
    status: "open",
    harness: "claude",
    backendSessionId: null,
    providerResumeId: null,
    association: {
      ticketId,
      ticketTitle: null,
      worktreePath,
      branch,
      lastProcessedAt: null,
      processedAtCount: 0,
      awaitingWorktree: null,
      recentWorktrees: [],
      ...(link ? { pullRequest: link } : {}),
      ...association,
    },
  } as unknown as ChatSession;
}

export function seedChats(...sessions: ChatSession[]) {
  useChatStore.setState({
    sessions: Object.fromEntries(
      sessions.map((session) => [session.id, session])
    ),
  });
}

export function chatLink(id: string): ChatPrLink | undefined {
  const association = useChatStore.getState().sessions[id]?.association as
    | { pullRequest?: ChatPrLink }
    | undefined;
  return association?.pullRequest;
}

/** Lets queued reads, answers and store updates settle. */
export async function settle(rounds = 6) {
  await act(async () => {
    for (let i = 0; i < rounds; i += 1) await Promise.resolve();
  });
}

export function resetFakeGithub() {
  resetPrSync();
  useChatStore.setState({ sessions: {} });
}
