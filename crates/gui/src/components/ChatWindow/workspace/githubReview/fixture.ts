import type {
  GithubReviewThread,
  GithubThreadAnchor,
  GithubThreadPlacement,
  GithubThreadPosition,
  GithubThreadWrite,
} from "../../../../bindings";

type ThreadOverrides = Partial<GithubThreadAnchor> &
  Partial<Omit<GithubReviewThread, "id" | "anchor">> & {
    author?: string;
    body?: string;
  };

const ANCHOR_KEYS = [
  "path",
  "side",
  "startSide",
  "line",
  "startLine",
  "originalLine",
  "originalStartLine",
  "originalCommitOid",
  "fileLevel",
  "outdated",
] as const satisfies readonly (keyof GithubThreadAnchor)[];

/**
 * A synthetic GitHub review thread on example/demo-repo. Anchor fields may
 * be given at the top level, as GitHub's thread has them.
 */
export function reviewThread(
  id: string,
  overrides: ThreadOverrides = {}
): GithubReviewThread {
  const { author = "alice", body = `Comment on ${id}`, ...rest } = overrides;
  const anchor: GithubThreadAnchor = {
    path: "src/lib.rs",
    side: "RIGHT",
    startSide: null,
    line: 13,
    startLine: null,
    originalLine: 13,
    originalStartLine: null,
    originalCommitOid: "1".repeat(40),
    fileLevel: false,
    outdated: false,
  };
  const thread: Omit<GithubReviewThread, "anchor"> = {
    id,
    resolved: false,
    viewerCanResolve: true,
    viewerCanUnresolve: false,
    viewerCanReply: true,
    comments: [
      {
        id: `${id}-c1`,
        author: { login: author },
        body,
        createdAt: "2026-11-20T10:00:00Z",
        url: `https://github.com/example/demo-repo/pull/7#discussion_${id}`,
      },
    ],
    commentsTruncated: false,
  };
  for (const [key, value] of Object.entries(rest)) {
    if ((ANCHOR_KEYS as readonly string[]).includes(key))
      Object.assign(anchor, { [key]: value });
    else Object.assign(thread, { [key]: value });
  }
  return { ...thread, anchor };
}

export function at(
  threadId: string,
  placement: GithubThreadPlacement
): GithubThreadPosition {
  return { threadId, placement };
}

export function anchored(
  line: number,
  publishedLine = line,
  startLine = line
): GithubThreadPlacement {
  return { kind: "anchored", startLine, line, publishedLine };
}

export function outdated(
  originalLine: number | null,
  text = "let x = 0;"
): GithubThreadPlacement {
  return {
    kind: "outdated",
    originalStartLine: originalLine,
    originalLine,
    original:
      originalLine === null
        ? []
        : [{ number: originalLine, text, focus: true }],
    originalCommit: originalLine === null ? null : "2".repeat(40),
  };
}

/**
 * `threads` with `write` applied as GitHub applies it, by `viewer`; the new
 * thread (or the reply's comment) gets `nodeId`. Synthetic only.
 */
export function applyThreadWrite(
  threads: readonly GithubReviewThread[],
  write: GithubThreadWrite,
  viewer: string,
  nodeId: string
): GithubReviewThread[] {
  const comment = (body: string) => ({
    id: nodeId,
    author: { login: viewer },
    body,
    createdAt: "2026-11-28T10:00:00Z",
    url: `https://github.com/example/demo-repo/pull/7#discussion_${nodeId}`,
  });
  if (write.kind === "start")
    return [
      ...threads,
      {
        ...reviewThread(nodeId, {
          path: write.path,
          side: write.side,
          startSide: write.startLine === null ? null : write.side,
          line: write.line,
          startLine: write.startLine,
          originalLine: write.line,
          originalStartLine: write.startLine,
        }),
        comments: [comment(write.body)],
      },
    ];
  return threads.map((thread) =>
    thread.id !== write.threadId
      ? thread
      : write.kind === "reply"
        ? { ...thread, comments: [...thread.comments, comment(write.body)] }
        : { ...thread, resolved: write.kind === "resolve" }
  );
}
