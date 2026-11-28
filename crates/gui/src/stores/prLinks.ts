import type { GithubPrState, GithubPullRequest, JsonValue } from "../bindings";
import { readRecord } from "../hooks/useChatAssociation";

/**
 * A chat's linked PR lives on its association record, saved with the chat
 * and projected to Sacrum (`pr_host`, `pr_owner`, `pr_repo`, `pr_number`).
 * It is written only by the PR sync (`prSync`), for every chat on the same
 * worktree branch at once, and is pinned to that worktree and branch: when
 * the association moves elsewhere the link no longer applies. A chat synced
 * from another machine has no worktree here; its link is pinned to none and
 * shown read-only (`savedPrOf`).
 */

/** The linked PR as last read from GitHub; Sacrum keeps only its identity. */
export type LinkedPr = {
  host: string;
  owner: string;
  repo: string;
  number: number;
  /** Empty until GitHub is read (a link that came from Sacrum). */
  title: string;
  /** `null` until GitHub is read. */
  state: GithubPrState | null;
  url: string;
};

export type ChatPrLink = {
  worktreePath: string;
  branch: string;
  /** `null`: the user unlinked; the branch is never linked automatically again. */
  pr: LinkedPr | null;
  /** When the link was last set; the newest wins across a branch's chats. */
  changedAt: string | null;
};

/** Not linked and not unlinked: the branch may be linked automatically. */
export type BranchLink = ChatPrLink | undefined;

type SessionLike = {
  discussion?: unknown;
  association?: unknown;
};

/** The chat's worktree branch, or null for the creation default and no branch. */
export function chatBranchOf(
  session: SessionLike
): { worktreePath: string; branch: string } | null {
  if (session.discussion) return null;
  const record = readRecord(session.association);
  if (record.defaultWorktree || !record.worktreePath || !record.branch)
    return null;
  return { worktreePath: record.worktreePath, branch: record.branch };
}

function isLinkedPr(value: unknown): value is LinkedPr {
  const pr = value as LinkedPr | null;
  return (
    !!pr &&
    typeof pr === "object" &&
    typeof pr.host === "string" &&
    typeof pr.owner === "string" &&
    typeof pr.repo === "string" &&
    Number.isSafeInteger(pr.number) &&
    pr.number > 0 &&
    typeof pr.title === "string" &&
    (pr.state === null || typeof pr.state === "string") &&
    typeof pr.url === "string"
  );
}

/** The `pullRequest` saved on an association, as stored. */
type SavedLink = {
  worktreePath?: unknown;
  branch?: unknown;
  pr?: unknown;
  changedAt?: unknown;
};

function savedLinkOf(association: unknown): SavedLink | null {
  if (!association || typeof association !== "object") return null;
  const link = (association as { pullRequest?: unknown }).pullRequest;
  return link && typeof link === "object" && !Array.isArray(link)
    ? (link as SavedLink)
    : null;
}

/** The chat's link for its current worktree branch, if it has one. */
export function chatPrLinkOf(session: SessionLike): BranchLink {
  const at = chatBranchOf(session);
  const link = savedLinkOf(session.association);
  if (!at || !link) return undefined;
  if (link.worktreePath !== at.worktreePath || link.branch !== at.branch)
    return undefined;
  if (link.pr !== null && !isLinkedPr(link.pr)) return undefined;
  if (link.changedAt !== null && typeof link.changedAt !== "string")
    return undefined;
  return { ...at, pr: link.pr, changedAt: link.changedAt };
}

/**
 * The PR saved on the chat for where it is associated, worktree or not: a
 * chat synced from another machine keeps its PR with no worktree here.
 */
export function savedPrOf(session: SessionLike): LinkedPr | null {
  if (session.discussion) return null;
  const record = readRecord(session.association);
  const link = savedLinkOf(session.association);
  if (!link || record.defaultWorktree) return null;
  const same = (saved: unknown, current: string | null) =>
    (saved ?? null) === current;
  return same(link.worktreePath, record.worktreePath) &&
    same(link.branch, record.branch) &&
    isLinkedPr(link.pr)
    ? link.pr
    : null;
}

/** The association with the chat's link saved on it. */
export function withPrLink(
  association: Partial<{ [key in string]: JsonValue }>,
  link: ChatPrLink
): Partial<{ [key in string]: JsonValue }> {
  return { ...association, pullRequest: link };
}

/** The link saved on an association, kept as stored when it changes. */
export function savedPrLinkValue(association: unknown): JsonValue | undefined {
  return (savedLinkOf(association) as JsonValue | null) ?? undefined;
}

/** The newer of two links of one branch; an undated link is the oldest. */
export function newerLink(a: BranchLink, b: BranchLink): BranchLink {
  if (!a) return b;
  if (!b) return a;
  return (b.changedAt ?? "") > (a.changedAt ?? "") ? b : a;
}

export function linkedPrFrom(host: string, pr: GithubPullRequest): LinkedPr {
  return {
    host,
    owner: pr.owner,
    repo: pr.repo,
    number: pr.number,
    title: pr.title,
    state: pr.state,
    url: pr.url,
  };
}

/** GitHub host and repository names are case-insensitive. */
export function remoteKey(host: string, repo: string): string {
  return `${host}/${repo}`.toLowerCase();
}

export function isSamePr(
  pr: Pick<LinkedPr, "host" | "owner" | "repo" | "number">,
  host: string,
  repo: string,
  number: number
): boolean {
  return (
    pr.number === number &&
    remoteKey(pr.host, `${pr.owner}/${pr.repo}`) === remoteKey(host, repo)
  );
}

export function samePr(a: LinkedPr | null, b: LinkedPr | null): boolean {
  if (!a || !b) return a === b;
  return (
    a.host === b.host &&
    a.owner === b.owner &&
    a.repo === b.repo &&
    a.number === b.number &&
    a.title === b.title &&
    a.state === b.state &&
    a.url === b.url
  );
}

export function sameLink(a: BranchLink, b: BranchLink): boolean {
  if (!a || !b) return a === b;
  return (
    a.worktreePath === b.worktreePath &&
    a.branch === b.branch &&
    a.changedAt === b.changedAt &&
    samePr(a.pr, b.pr)
  );
}

export const isSameLinkedPr = (
  a: LinkedPr | null | undefined,
  b: LinkedPr | null
) => !!a && !!b && isSamePr(a, b.host, `${b.owner}/${b.repo}`, b.number);
