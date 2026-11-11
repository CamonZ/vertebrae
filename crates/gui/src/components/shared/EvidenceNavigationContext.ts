import { createContext } from "react";

/** Source coordinates are one-based and relative to the conversation worktree. */
export interface SourceLocation {
  path: string;
  line?: number;
  endLine?: number;
  side?: "old" | "new";
}

export const EvidenceNavigationContext = createContext<
  ((location: SourceLocation) => void) | undefined
>(undefined);
