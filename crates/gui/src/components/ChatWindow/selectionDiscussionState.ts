import { createContext } from "react";
import type {
  CodeSelection,
  DiscussionState,
  ThreadAnchor,
} from "./selectionDiscussions";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";

export interface DiscussionActions {
  canAsk: boolean;
  select(anchor: CodeSelection | null): void;
  discuss(anchor: CodeSelection, question: string): Promise<boolean>;
  attach(anchor: CodeSelection, outdated?: boolean, question?: string): void;
  /** `focus` puts the caret in the opened discussion's composer. */
  reopen(id: string | null, options?: { focus?: boolean }): void;
  send(id: string, text: string): void;
  cancel(id: string): void;
  reconcile(snapshot: WorktreeSnapshot): void;
  /** Show only the latest response of a thread, or every turn again. */
  toggleCollapsed(id: string): void;
  /** The thread's composer took the focus `reopen` asked for. */
  focusTaken(id: string): void;
}

/** Presentation-only state, kept per thread while the pane is open. */
export interface DiscussionPresentation {
  /** Threads showing only their latest response. */
  collapsed: ReadonlySet<string>;
  /** The thread whose composer should take focus once it renders. */
  focusRequest: string | null;
}

export type DiscussionValue = DiscussionState &
  DiscussionActions &
  DiscussionPresentation & { projectPath?: string; anchorError: string | null };

export const SelectionDiscussionActionsContext =
  createContext<DiscussionActions | null>(null);

export const SelectionDiscussionAnchorsContext = createContext<
  readonly ThreadAnchor[]
>([]);

/** The selected anchor changes only on an explicit selection, never on streamed text. */
export const SelectionDiscussionSelectionContext =
  createContext<CodeSelection | null>(null);

export const SelectionDiscussionContext = createContext<DiscussionValue | null>(
  null
);

export const SelectionDiscussionModelContext = createContext<{
  label: string;
  error: string | null;
} | null>(null);
