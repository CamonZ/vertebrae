import { commands, type FileBody } from "../../../bindings";
import type { ResolvedSource } from "./resolveSource";

export type TurnSource = Extract<
  ResolvedSource,
  { kind: "file" | "unavailable" }
>;

/** Read exactly one recorded or current file, with explicit recoverability. */
export async function resolveTurnSource(
  checkout: string,
  path: string,
  history: { sessionId: string; turnId: string | null },
  latest: boolean
): Promise<TurnSource> {
  const turnId = history.turnId;
  if (latest && !checkout)
    return {
      kind: "unavailable",
      message: "The original checkout was not recorded for this reference.",
      retryable: false,
    };
  let body: FileBody;
  if (latest) {
    const result = await commands.readWorktreeFile(checkout, path);
    if (result.status === "error")
      return {
        kind: "unavailable",
        message: result.error.message,
        retryable: true,
      };
    body = result.data;
  } else {
    if (!turnId)
      return {
        kind: "unavailable",
        message: "Historical context was not captured for this reference.",
        retryable: false,
      };
    const result = await commands.readChatHistoryFile(
      history.sessionId,
      turnId,
      path
    );
    if (result.status === "error")
      return {
        kind: "unavailable",
        message: result.error.message,
        retryable: true,
      };
    if ("error" in result.data)
      return {
        kind: "unavailable",
        message: result.data.error.message,
        retryable: result.data.error.retryable,
      };
    body = result.data;
  }
  switch (body.kind) {
    case "text":
      return {
        kind: "file",
        path,
        contents: body.contents,
        note: latest
          ? "Current working-directory contents"
          : "Recorded turn contents · Read-only",
      };
    case "missing":
      return {
        kind: "unavailable",
        message: latest
          ? "This file no longer exists in its worktree."
          : "No file contents are present in this turn’s captured state.",
        retryable: latest,
      };
    case "unreadable":
      return { kind: "unavailable", message: body.message, retryable: latest };
    case "binary":
      return {
        kind: "unavailable",
        message: "Binary contents are not available in this view.",
        retryable: false,
      };
    case "too_large":
      return {
        kind: "unavailable",
        message: "This file exceeds the view’s size limit.",
        retryable: false,
      };
  }
  const exhaustive: never = body;
  throw new Error(`Unexpected file result: ${String(exhaustive)}`);
}
