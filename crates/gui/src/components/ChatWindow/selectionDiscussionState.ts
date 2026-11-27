import {
  createContext,
  useContext,
  useState,
  useSyncExternalStore,
} from "react";
import {
  SelectionDiscussions,
  type CodeSelection,
  type DiscussionState,
  type ThreadAnchor,
} from "./selectionDiscussions";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";
import type { PlacedThread } from "./workspace/githubReview/model";

/**
 * Whether a GitHub thread's discussion opened; else why not: the capture's
 * error, or null when it cannot start here (or one is already starting).
 */
export type GithubDiscussResult =
  | { opened: true }
  | { opened: false; error: string | null };

export interface DiscussionActions {
  canAsk: boolean;
  canAskFullFile?: boolean;
  select(anchor: CodeSelection | null): void;
  discuss(anchor: CodeSelection, question: string): Promise<boolean>;
  /**
   * Discuss a GitHub review thread privately, at the lines it is commented
   * on; reopens its discussion if it has one.
   */
  discussGithub(placed: PlacedThread): Promise<GithubDiscussResult>;
  attach(anchor: CodeSelection, outdated?: boolean, question?: string): void;
  /** Send to main chat: attach a thread (and a GitHub thread's discussion). */
  attachThread(id: string, question: string): void;
  /** Whether Send to main chat is offered for GitHub threads here. */
  canAttachGithub: boolean;
  /**
   * Send to main chat for a GitHub thread: with its private discussion when
   * it has one, else the thread alone.
   */
  attachGithub(placed: PlacedThread): void;
  /**
   * `focus` puts the caret in the opened discussion's composer. `inPlace`
   * opens it where it is listed instead of showing its anchor in Changes.
   */
  reopen(
    id: string | null,
    options?: { focus?: boolean; inPlace?: boolean }
  ): void;
  send(id: string, text: string): void;
  cancel(id: string): void;
  reconcile(snapshot: WorktreeSnapshot): void;
  /** Show only the latest response of a thread, or every turn again. */
  toggleCollapsed(id: string): void;
  /** The thread's composer took the focus `reopen` asked for. */
  focusTaken(id: string): void;
  /** Changes showed the GitHub thread `reveal` asked for. */
  revealed(nonce: number): void;
  /** A thread's unsent question, kept while it is closed. */
  draft(id: string): string;
  setDraft(id: string, text: string): void;
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

/** What the header's Discussions toggle and the switcher count show. */
export function useDiscussionSummary(): { count: number; alert: boolean } {
  const discussion = useContext(SelectionDiscussionContext);
  return {
    count: discussion?.threads.length ?? 0,
    alert: !!discussion?.anchorError,
  };
}

/**
 * The chat's discussion controller, made anew when `key` (its checkout and
 * chat) changes, and its thread count: the side column's Discussions count
 * is needed outside the provider, by the chat's shortcuts.
 */
export function useChatDiscussions(key: string): {
  controller: SelectionDiscussions;
  count: number;
} {
  const [owned, setOwned] = useState(() => ({
    key,
    controller: new SelectionDiscussions(),
  }));
  let { controller } = owned;
  if (owned.key !== key) {
    controller = new SelectionDiscussions();
    setOwned({ key, controller });
  }
  const count = useSyncExternalStore(
    controller.subscribe,
    () => controller.getSnapshot().threads.length
  );
  return { controller, count };
}
