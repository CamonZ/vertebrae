/**
 * Comment on GitHub straight from a selection in Changes, with no private
 * discussion: the text typed in the selection box starts a GitHub thread on
 * the selected lines once they are on the PR unchanged. The button (or
 * ⌘⌥↵) posts it at once; a failed post keeps the text and says why.
 */
import { useContext, useEffect, useMemo, type ReactNode } from "react";
import { commands } from "../../../../bindings";
import {
  DIFF_COMPOSER_GITHUB_SHORTCUT,
  shortcutText,
} from "../../chatShortcuts";
import { unwrapAnchor } from "../../reviewAnchors";
import type { CodeSelection } from "../../selectionDiscussions";
import { SelectionDiscussionActionsContext } from "../../selectionDiscussionState";
import { rangeLabel } from "./DiscussionGithub";
import { GithubPostButton, WriteFailureAlert } from "./GithubWriteControls";
import { useGithubWrites, useWriteSlot } from "./threadWritesContext";
import { unplacedReason, usePlaceOnPr, type PlaceQuery } from "./usePlaceOnPr";

/** A selection's comment write on the PR `scope`, kept per side, file and lines. */
export const selectionSlot = (scope: string, anchor: CodeSelection) =>
  `selection:${scope}:${anchor.side}:${anchor.path}:${anchor.startLine}-${anchor.endLine}`;

export interface SelectionGithub {
  /** The Comment on GitHub button; null with nowhere to post. */
  action: ReactNode;
  /** Why the last post failed, with its retry. */
  status: ReactNode;
  /** Posts the text now; null while it cannot. */
  post: (() => void) | null;
  /** A post is out; the text must stay as sent. */
  busy: boolean;
  /**
   * A post whose outcome is unknown may be on GitHub: the text stays as
   * sent until the check says what happened.
   */
  held: boolean;
  /** Where ⌘⌥↵ posts and as whom, for the hint row; null with nowhere. */
  target: string | null;
  /** The selection closed: forget a failed post. */
  reset(): void;
}

const NONE: SelectionGithub = {
  action: null,
  status: null,
  post: null,
  busy: false,
  held: false,
  target: null,
  reset: () => {},
};

/**
 * Posting `body` as a new GitHub thread on `anchor`'s lines; inert with no
 * PR to post to or for a selection outside the worktree's Changes.
 */
export function useSelectionGithub(
  anchor: CodeSelection | null,
  body: string,
  onPosted: () => void
): SelectionGithub {
  const writes = useGithubWrites();
  const actions = useContext(SelectionDiscussionActionsContext);
  // Only what the check reads: a reread of the threads leaves it alone.
  const worktreePath = writes?.worktreePath;
  const headOid = writes?.threads.headOid;
  const baseOid = writes?.threads.baseOid;
  const query = useMemo<PlaceQuery | null>(() => {
    const from = anchor && actions?.locate?.(anchor);
    if (!anchor || !from || !worktreePath || !headOid || !baseOid)
      return null;
    const range = { startLine: anchor.startLine, line: anchor.endLine };
    const onto = {
      path: from.path,
      side: from.side,
      source: {
        kind: "worktree" as const,
        commit: from.side === "LEFT" ? baseOid : headOid,
      },
    };
    return {
      path: onto.path,
      side: onto.side,
      map: () =>
        unwrapAnchor(
          commands.mapReviewSelection(worktreePath, from, range, onto)
        ),
    };
  }, [anchor, actions, worktreePath, headOid, baseOid]);
  const published = usePlaceOnPr(query);
  const key =
    anchor && writes ? selectionSlot(writes.scope, anchor) : "selection:none";
  const slot = useWriteSlot(writes?.store, key);
  const store = writes?.store;
  // A selection that closes or moves takes its failed post with it.
  useEffect(() => () => store?.forget(key), [store, key]);
  if (!writes || !published) return NONE;
  const place = published.kind === "published" ? published.place : null;
  const text = body.trim();
  const busy = slot.pending !== null;
  // A refused or unconfirmed post is finished on GitHub, not here; a
  // rejected one posts again once the text changes.
  const failed = slot.failure;
  const settled =
    failed?.kind === "forbidden" ||
    failed?.kind === "unconfirmed" ||
    (failed?.kind === "rejected" &&
      failed.sent.kind === "start" &&
      failed.sent.body === text);
  const post =
    place && text && !busy && !settled
      ? () => {
          const { store } = writes;
          const port = writes.port(() => onPosted());
          store.open(key, text);
          store.edit(key, text);
          // A post that may have landed is checked on GitHub before it is
          // sent again.
          if (failed?.kind === "ambiguous") void store.retry(key, port);
          else
            void store.post(
              key,
              {
                kind: "start",
                pullRequestId: writes.threads.pullRequestId,
                place,
              },
              port
            );
        }
      : null;
  const title =
    published.kind !== "published"
      ? unplacedReason(published, writes.pr.number)
      : `Post to PR #${writes.pr.number}, ${rangeLabel(published.place)} · visible to everyone on the PR${
          writes.viewer ? ` as ${writes.viewer}` : ""
        }`;
  return {
    action: (
      <GithubPostButton
        disabled={!post}
        pending={busy}
        title={
          post
            ? `${title} (${shortcutText(DIFF_COMPOSER_GITHUB_SHORTCUT)})`
            : title
        }
        keyShortcuts="Meta+Alt+Enter"
        onClick={() => post?.()}
      >
        Comment on GitHub
      </GithubPostButton>
    ),
    status: slot.failure && (
      <WriteFailureAlert
        failure={slot.failure}
        draftKept
        url={`${writes.pr.url}/files`}
        pending={busy}
        onRetry={() => post?.()}
      />
    ),
    post,
    busy,
    held: failed?.kind === "ambiguous",
    target: place
      ? `#${writes.pr.number} ${rangeLabel(place)}${
          writes.viewer ? ` as ${writes.viewer}` : ""
        }`
      : null,
    reset: () => writes.store.forget(key),
  };
}
