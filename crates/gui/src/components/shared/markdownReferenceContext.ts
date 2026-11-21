import { createContext, useContext } from "react";

/** The message being rendered: its project, session, turn and checkout. */
export const ReferenceContext = createContext<{
  replyId?: string;
  projectPath: string | null;
  roots: readonly string[];
  sessionId: string | null;
  turnId?: string;
  capturedRoot: string | null;
  assignedRoot: string | null;
}>({
  projectPath: null,
  roots: [],
  sessionId: null,
  capturedRoot: null,
  assignedRoot: null,
});

/**
 * The checkout a message's code belongs to: the turn's captured worktree,
 * else the project root. Null outside a project.
 */
export function useMarkdownCheckout(): string | null {
  const { projectPath, assignedRoot } = useContext(ReferenceContext);
  return assignedRoot ?? projectPath;
}
