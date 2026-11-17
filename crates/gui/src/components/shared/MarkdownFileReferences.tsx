import { annotationWorktree } from "../../stores/toolAnnotations";
import { createContext, useContext, type ReactNode } from "react";
import { ChatSessionContext } from "../thread/toolChange/ChatSessionContext";
import { useChatStore } from "../../stores/chatStore";
import { fileReferenceReplyTurns } from "../../utils/fileReferenceReplyIds";
import { useToolAnnotation } from "../../hooks/useToolAnnotation";
import {
  parseFileReferenceDestination,
  parseLocalFileReference,
} from "./localFileReference";
import { LocalFileReferenceLink } from "./LocalFileReferenceLink";
import { ChatFileReferenceLink } from "./ChatFileReferenceLink";

const ReferenceContext = createContext<{
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

export function MarkdownFileReferences({
  replyId,
  projectPath,
  roots,
  children,
}: {
  replyId?: string;
  projectPath: string | null;
  roots: readonly string[];
  children: ReactNode;
}) {
  const sessionId = useContext(ChatSessionContext);
  const turnId = useChatStore((state) => {
    const messages = sessionId
      ? state.sessions[sessionId]?.messages
      : undefined;
    if (!messages || !replyId) return undefined;
    return fileReferenceReplyTurns(messages).get(replyId);
  });
  const capture = useToolAnnotation(
    sessionId,
    turnId ? JSON.stringify(["turn", turnId]) : null,
    "worktree_history"
  );
  const origin = useToolAnnotation(
    sessionId,
    turnId ? JSON.stringify(["turn", turnId]) : null,
    "worktree_origin"
  );
  const capturedRoot = annotationWorktree(capture);
  const assignedRoot = annotationWorktree(origin) ?? capturedRoot;

  return (
    <ReferenceContext.Provider
      value={{
        replyId,
        projectPath,
        roots,
        sessionId,
        turnId,
        capturedRoot,
        assignedRoot,
      }}
    >
      {children}
    </ReferenceContext.Provider>
  );
}

/** Uses react-markdown's existing parse; no additional streamed Markdown parse. */
export function MarkdownFileReference({
  destination,
  syntax,
  fallback,
  children,
}: {
  destination: string;
  syntax: "inline" | "link";
  fallback: ReactNode;
  children: ReactNode;
}) {
  const { replyId, projectPath, roots, sessionId, turnId, assignedRoot } =
    useContext(ReferenceContext);
  if (!projectPath) return fallback;

  if (sessionId && replyId) {
    // Only the captured checkout and project root are eligible. Prose and
    // sibling worktree inventories never select a destination.
    const parsed = parseFileReferenceDestination(
      { destination, syntax },
      assignedRoot ?? projectPath,
      assignedRoot ? [assignedRoot, projectPath] : [projectPath]
    );
    if (!parsed) return fallback;
    // An explicit other checkout is not equivalent to this turn's capture.
    const historical = turnId && (!parsed.root || parsed.root === assignedRoot);
    return (
      <ChatFileReferenceLink
        target={{
          root: parsed.root ?? assignedRoot,
          path: parsed.path,
          line: parsed.line,
          column: parsed.column,
          history: { sessionId, turnId: historical ? turnId : null },
        }}
        unavailable={
          !historical || !assignedRoot
            ? "Historical context is unavailable for this reference; view the latest file explicitly."
            : undefined
        }
      >
        {children}
      </ChatFileReferenceLink>
    );
  }

  if (syntax === "inline") {
    const reference = parseLocalFileReference(destination, projectPath, roots);
    if (reference)
      return (
        <LocalFileReferenceLink reference={reference} projectRoot={projectPath}>
          {children}
        </LocalFileReferenceLink>
      );
  }
  return fallback;
}
