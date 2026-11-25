import type {
  GithubReviewThread,
  GithubThreadPlacement,
  GithubThreadPosition,
} from "../../../bindings";

/** A synthetic GitHub review thread on example/demo-repo. */
export function reviewThread(
  id: string,
  overrides: Partial<GithubReviewThread> & {
    author?: string;
    body?: string;
  } = {}
): GithubReviewThread {
  const { author = "alice", body = `Comment on ${id}`, ...rest } = overrides;
  return {
    id,
    path: "src/lib.rs",
    side: "right",
    line: 13,
    startLine: null,
    originalLine: 13,
    originalStartLine: null,
    originalCommitOid: "1".repeat(40),
    fileLevel: false,
    outdated: false,
    resolved: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    comments: [
      {
        id: `${id}-c1`,
        author: { login: author, avatarUrl: null },
        body,
        createdAt: "2026-11-20T10:00:00Z",
        url: `https://github.com/example/demo-repo/pull/7#discussion_${id}`,
      },
    ],
    commentsTruncated: false,
    ...rest,
  };
}

export function at(
  threadId: string,
  placement: GithubThreadPlacement
): GithubThreadPosition {
  return { threadId, placement };
}

export function anchored(
  line: number,
  publishedLine = line
): GithubThreadPlacement {
  return { kind: "anchored", startLine: line, line, publishedLine };
}
