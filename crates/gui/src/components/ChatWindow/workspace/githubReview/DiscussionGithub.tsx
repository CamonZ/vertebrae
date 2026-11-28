/**
 * A private discussion's ways onto GitHub, each needing its own post: a
 * GitHub thread's discussion drafts the thread's reply from its latest
 * answer; a line discussion starts a thread with a comment once its lines
 * are published on the PR, then moves under that thread.
 */
import { useMemo, type ReactNode } from "react";
import {
  commands,
  type GithubPrReviewThreads,
  type ReviewMappingRequest,
} from "../../../../bindings";
import type { ChatMessage } from "../../../../stores/chatStore";
import { unwrapAnchor } from "../../reviewAnchors";
import type { SelectionThread } from "../../selectionDiscussions";
import type { DiscussionValue } from "../../selectionDiscussionState";
import { GithubComposer, GithubPostButton } from "./GithubWriteControls";
import { commentSlot, replySlot, type NewThreadPlace } from "./threadWrites";
import {
  unplacedReason,
  usePlaceOnPr,
  type PlaceQuery,
  type PublishedPlace,
} from "./usePlaceOnPr";
import {
  useGithubWrites,
  useWriteSlot,
  type GithubWritesValue,
} from "./threadWritesContext";

/** The discussion's latest answer: what a public post starts from. */
export function latestAnswer(messages: readonly ChatMessage[]): string {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (
      message.kind === "assistant" &&
      !message.parentToolUseId &&
      message.text.trim()
    )
      return message.text.trim();
  }
  return "";
}

/**
 * Where a line discussion's captured lines are on the PR's published side
 * (its head, or its base for removed lines); null for any other discussion.
 */
export function publishedRequest(
  thread: SelectionThread,
  threads: Pick<GithubPrReviewThreads, "headOid" | "baseOid">
): ReviewMappingRequest | null {
  const { original, capture } = thread.git;
  if (
    thread.githubThreadId !== null ||
    original.home.kind !== "worktree" ||
    original.fullFile ||
    thread.status.kind === "unreadable"
  )
    return null;
  const side = original.side === "old" ? "LEFT" : "RIGHT";
  return {
    threadId: thread.id,
    originalBlobId: capture.originalBlobId,
    range: { startLine: original.startLine, line: original.endLine },
    location: {
      path:
        side === "LEFT"
          ? (original.file.oldPath ?? original.path)
          : original.path,
      side,
      source: {
        kind: "worktree",
        commit: side === "LEFT" ? threads.baseOid : threads.headOid,
      },
    },
  };
}

/** Whether the discussion's lines are on the PR, unchanged, and where. */
function usePublishedPlace(
  thread: SelectionThread,
  writes: GithubWritesValue | null
): PublishedPlace | null {
  // Only what the check reads: a reread of the threads leaves it alone.
  const headOid = writes?.threads.headOid;
  const baseOid = writes?.threads.baseOid;
  const request = useMemo(
    () =>
      headOid !== undefined && baseOid !== undefined
        ? publishedRequest(thread, { headOid, baseOid })
        : null,
    [thread, headOid, baseOid]
  );
  const worktree = writes?.worktreePath;
  const query = useMemo<PlaceQuery | null>(
    () =>
      request && worktree
        ? {
            path: request.location.path,
            side: request.location.side,
            map: () =>
              unwrapAnchor(commands.mapReviewThreads(worktree, [request])).then(
                ([mapped]) =>
                  mapped ?? {
                    status: "unavailable",
                    startLine: null,
                    line: null,
                  }
              ),
          }
        : null,
    [request, worktree]
  );
  return usePlaceOnPr(query);
}

export const rangeLabel = ({ path, startLine, line }: NewThreadPlace) =>
  `${path}:${startLine !== null ? `${startLine}–${line}` : line}`;

/**
 * The discussion's GitHub action for its composer's row, and the comment
 * composer it opens. Nothing for a discussion with no PR to post to.
 */
export function useDiscussionGithub(
  thread: SelectionThread,
  discussion: DiscussionValue,
  messages: readonly ChatMessage[]
): { action: ReactNode; composer: ReactNode } {
  const writes = useGithubWrites();
  const published = usePublishedPlace(thread, writes);
  const key =
    thread.githubThreadId !== null
      ? replySlot(thread.githubThreadId)
      : commentSlot(writes?.scope ?? "", thread.id);
  const slot = useWriteSlot(writes?.store, key);
  if (!writes) return { action: null, composer: null };
  if (thread.githubThreadId !== null) {
    const github = writes.threads.threads.find(
      ({ id }) => id === thread.githubThreadId
    );
    if (!github?.viewerCanReply) return { action: null, composer: null };
    return {
      action: (
        <GithubPostButton
          disabled={slot.draft !== null}
          title={
            slot.draft !== null
              ? "The reply draft is open on the thread"
              : "Draft the thread’s reply from this discussion; posting is separate"
          }
          onClick={() => writes.store.open(key, latestAnswer(messages))}
        >
          Draft reply
        </GithubPostButton>
      ),
      composer: null,
    };
  }
  if (!published) return { action: null, composer: null };
  const place = published.kind === "published" ? published.place : null;
  const action = (
    <GithubPostButton
      disabled={!place || slot.draft !== null}
      title={
        published.kind !== "published"
          ? unplacedReason(published, writes.pr.number)
          : `Start a GitHub thread on ${rangeLabel(published.place)}; posting is separate`
      }
      onClick={() => writes.store.open(key, latestAnswer(messages))}
    >
      Comment on GitHub
    </GithubPostButton>
  );
  const composer = place && (
    <GithubComposer
      store={writes.store}
      slotKey={key}
      title="Comment on GitHub"
      audience={`starts a thread on #${writes.pr.number}, ${rangeLabel(place)} · visible to everyone on the PR${
        writes.viewer ? ` as ${writes.viewer}` : ""
      }`}
      textLabel="Comment on GitHub"
      placeholder="Write a comment…"
      posts={[
        {
          label: "Post comment",
          plan: {
            kind: "start",
            pullRequestId: writes.threads.pullRequestId,
            place,
          },
        },
      ]}
      port={writes.port((threadId) =>
        discussion.moveUnderGithub(thread.id, threadId)
      )}
      url={`${writes.pr.url}/files`}
    />
  );
  return {
    action,
    composer:
      composer ??
      (slot.draft !== null || slot.discarded !== null ? (
        <p className="gh-mute gh-thread-note" role="status">
          Your comment draft is kept;{" "}
          {published.kind === "unavailable"
            ? `these lines can’t be checked against PR #${writes.pr.number} yet.`
            : `these lines aren’t on PR #${writes.pr.number} yet.`}
        </p>
      ) : null),
  };
}
