import { createContext } from "react";
import type {
  CodeSelection,
  DiscussionState,
  ThreadAnchor,
} from "./selectionDiscussions";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";

export interface DiscussionActions {
  select(anchor: CodeSelection | null): void;
  ask(): void;
  discuss(anchor: CodeSelection, question: string): void;
  attach(anchor: CodeSelection, outdated?: boolean, question?: string): void;
  reopen(id: string | null): void;
  send(id: string, text: string): void;
  cancel(id: string): void;
  reconcile(snapshot: WorktreeSnapshot): void;
}

export type DiscussionValue = DiscussionState &
  DiscussionActions & { projectPath?: string };

export const SelectionDiscussionActionsContext =
  createContext<DiscussionActions | null>(null);

export const SelectionDiscussionAnchorsContext = createContext<
  readonly ThreadAnchor[]
>([]);

/** The selected anchor changes only on an explicit selection, never on streamed text. */
export const SelectionDiscussionSelectionContext =
  createContext<CodeSelection | null>(null);

export function discussionErrorCategory(error: unknown): string {
  if (error && typeof error === "object") {
    return Object.keys(error)[0] ?? "unknown";
  }

  return "transport";
}

export function discussionErrorMessage(error: unknown): string {
  switch (discussionErrorCategory(error)) {
    case "UnavailableHarness":
      return "The selected AI provider is unavailable. Check your provider settings and try again.";
    case "StartFailed":
    case "SpawnFailed":
      return "Could not start the discussion. Check your provider settings and try again.";
    case "SessionNotFound":
      return "The discussion session ended. Ask again to start a new reply.";
    case "SendFailed":
      return "Could not send your question. Please try again.";
    default:
      return "The discussion could not complete. Please try again.";
  }
}

export const SelectionDiscussionContext = createContext<DiscussionValue | null>(
  null
);

export const SelectionDiscussionModelContext = createContext<{
  label: string;
  error: string | null;
} | null>(null);
