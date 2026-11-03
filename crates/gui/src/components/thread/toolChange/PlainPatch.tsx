import type { ReactNode } from "react";
import { DEFAULT_DIFF_HEIGHT } from "./ResizableDiffViewport";

/** Pierre's default row height, which the placeholder matches. */
const PLAIN_ROW_PX = 20;

/** Patch lines below the file headers, shown verbatim. */
function patchBody(patch: string): string[] {
  return patch
    .split("\n")
    .filter((line) => !/^(diff --git|index |--- |\+\+\+ )/.test(line));
}

/**
 * Unhighlighted patch text, sized like Pierre's rows. Stands in for diffs far
 * from the visible area and while Pierre loads, so long chats only pay for
 * the diffs a user can reach. Only the rows that fit `limit` are laid out;
 * the full height is reserved so scrolling inside stays consistent.
 */
export function PlainPatch({
  patches,
  limit = DEFAULT_DIFF_HEIGHT,
}: {
  patches: string[];
  limit?: number;
}): ReactNode {
  const lines = patches.flatMap(patchBody);
  return (
    <pre
      className="evdiff-plain"
      data-testid="diff-placeholder"
      style={{ height: lines.length * PLAIN_ROW_PX }}
    >
      {lines.slice(0, Math.ceil(limit / PLAIN_ROW_PX)).join("\n")}
    </pre>
  );
}
