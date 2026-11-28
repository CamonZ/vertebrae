/**
 * Whether some lines are on the PR's published diff, unchanged, and where:
 * what a new GitHub thread on them needs. A line discussion and a selection
 * in Changes both ask.
 */
import { useEffect, useState } from "react";
import type {
  MappedReviewRange,
  ReviewThreadSide,
} from "../../../../bindings";
import type { NewThreadPlace } from "./threadWrites";

export type PublishedPlace =
  | { kind: "checking" }
  | { kind: "published"; place: NewThreadPlace }
  /** The lines differ from the PR: they have to be pushed first. */
  | { kind: "unpublished" }
  /**
   * The check could not run: the PR's commits are not in the worktree (not
   * fetched yet) or Git could not read them. Pushing would not help.
   */
  | { kind: "unavailable" };

/**
 * A check of whether some lines are on the PR. Callers memoize it on its
 * content, so a new query is a new check.
 */
export interface PlaceQuery {
  path: string;
  side: ReviewThreadSide;
  map(): Promise<Pick<MappedReviewRange, "status" | "startLine" | "line">>;
}

/** What a mapping onto the PR's side says of the lines; null for an error. */
export function placeOf(
  query: Pick<PlaceQuery, "path" | "side">,
  mapped: Pick<MappedReviewRange, "status" | "startLine" | "line"> | null
): PublishedPlace {
  if (!mapped || mapped.status === "unavailable")
    return { kind: "unavailable" };
  if (mapped.status !== "open" || mapped.line == null)
    return { kind: "unpublished" };
  const { startLine, line } = mapped;
  return {
    kind: "published",
    place: {
      path: query.path,
      side: query.side,
      startLine: startLine != null && startLine < line ? startLine : null,
      line,
    },
  };
}

/** Whether `query`'s lines are on the PR, unchanged, and where. */
export function usePlaceOnPr(query: PlaceQuery | null): PublishedPlace | null {
  const [answer, setAnswer] = useState<{
    query: PlaceQuery;
    place: PublishedPlace;
  } | null>(null);
  useEffect(() => {
    if (!query) return;
    let current = true;
    const settle = (place: PublishedPlace) => {
      if (current) setAnswer({ query, place });
    };
    query
      .map()
      .then((mapped) => settle(placeOf(query, mapped)))
      .catch(() => settle(placeOf(query, null)));
    return () => {
      current = false;
    };
  }, [query]);
  if (!query) return null;
  return answer?.query === query ? answer.place : { kind: "checking" };
}

/** Why a place cannot take a new thread, for its button's title. */
export function unplacedReason(
  published: Exclude<PublishedPlace, { kind: "published" }>,
  prNumber: number
): string {
  switch (published.kind) {
    case "checking":
      return "Checking the lines are on the PR…";
    case "unpublished":
      return `These lines aren’t on PR #${prNumber} yet · push them first`;
    case "unavailable":
      return `Can’t check these lines against PR #${prNumber}: its commits aren’t in this worktree yet · fetch them, or reopen Changes`;
  }
}
