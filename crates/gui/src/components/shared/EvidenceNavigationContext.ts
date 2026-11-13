import { createContext } from "react";

/**
 * Source coordinates are one-based and relative to the conversation's
 * checkout: its own worktree when it has one, otherwise its project.
 */
export interface SourceLocation {
  path: string;
  line?: number;
  endLine?: number;
  /** Which side of a diff the line numbers refer to. */
  side?: "old" | "new";
  /** Diff range: `base` against `head`, or the working copy without `head`. */
  base?: string;
  head?: string;
}

export const EvidenceNavigationContext = createContext<
  ((location: SourceLocation) => void) | undefined
>(undefined);
