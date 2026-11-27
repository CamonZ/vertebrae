import type { CapturedReviewAnchor, MappedReviewThread } from "../../bindings";
import type { GithubDiscussionContext } from "./workspace/githubReview/githubDiscussion";
import type { SelectedLineRange } from "@pierre/diffs";
import type {
  DiffCommentHome,
  PendingDiffComment,
} from "./assistantTextComments";
import {
  canonicalPath,
  resolveSelection,
  spanRows,
  type FilePatch,
  type LineSpan,
} from "../thread/toolChange/diffLineMapper";
import {
  createDiffComment,
  type ReviewSurface,
  type WorktreeSnapshot,
} from "../thread/toolChange/diffComments";

export interface FullFileSource {
  checkout: string;
  turn: { sessionId: string; turnId: string } | null;
}

export function sameFullFile(
  a: FullFileSource | undefined,
  b: FullFileSource | undefined
) {
  return (
    a?.checkout === b?.checkout &&
    a?.turn?.sessionId === b?.turn?.sessionId &&
    a?.turn?.turnId === b?.turn?.turnId
  );
}

export interface CodeSelection extends LineSpan {
  path: string;
  code: string;
  file: FilePatch;
  home: DiffCommentHome;
  fullFile?: FullFileSource;
}

/** Where a thread's captured lines are kept: its commit and retained blob. */
export type ReviewAnchorIds = Pick<
  CapturedReviewAnchor,
  "originalCommitId" | "originalBlobId"
>;

export interface SelectionThread {
  id: string;
  anchor: CodeSelection;
  status: ThreadStatus;
  git: { original: CodeSelection; capture: ReviewAnchorIds };
  /** Whether the agent has been told the context is outdated. */
  outdatedNoted: boolean;

  /** The read-only chat session the conversation runs in, once asked. */
  sessionId: string | null;

  /**
   * The GitHub review thread this privately discusses. It is drawn with that
   * thread wherever the thread shows (its line, Outdated group or the Review
   * rail), so it follows GitHub's anchor rather than its own.
   */
  githubThreadId: string | null;
}

export type ThreadStatus =
  | { kind: "inline" | "detached" | "outdated" }
  | { kind: "unreadable"; message: string }
  | { kind: "unavailable"; lastKnown: "open" | "outdated" };

export function isOutdated({ status }: SelectionThread): boolean {
  return (
    status.kind === "outdated" ||
    (status.kind === "unavailable" && status.lastKnown === "outdated")
  );
}

/**
 * A selection attached to the composer as a comment, carrying its code; a
 * full-file selection keeps its own code as the hunk. Null if no row matches.
 */
export function selectionAttachment(
  anchor: CodeSelection,
  id: string,
  body: string,
  outdated: boolean
): PendingDiffComment | null {
  const comment: PendingDiffComment | null = anchor.fullFile
    ? {
        kind: "diff",
        id,
        body,
        outdated,
        home: anchor.home,
        path: anchor.path,
        side: anchor.side,
        startLine: anchor.startLine,
        endLine: anchor.endLine,
        hunk: anchor.code,
      }
    : createDiffComment({
        home: anchor.home,
        file: anchor.file,
        span: anchor,
        body,
        id,
      });
  return comment && { ...comment, selectionCode: anchor.code, outdated };
}

/** Whether a selection anchors in the chat's Changes view (its home there). */
export function anchorsInChanges(anchor: CodeSelection): boolean {
  return anchor.home.kind === "worktree" && !anchor.fullFile;
}

/**
 * Where a thread is drawn: with its GitHub thread, nowhere when detached,
 * else at its anchor in Changes, a tool call's patch in the transcript, or a
 * full-file document.
 */
export type ThreadPlace =
  | "detached"
  | "changes"
  | "github"
  | "transcript"
  | "document";

export function threadPlace({
  status,
  anchor,
  githubThreadId,
}: SelectionThread): ThreadPlace {
  if (githubThreadId !== null) return "github";
  if (status.kind !== "inline") return "detached";
  if (anchor.fullFile) return "document";
  return anchor.home.kind === "worktree" ? "changes" : "transcript";
}

export const THREAD_PLACES: readonly ThreadPlace[] = [
  "detached",
  "changes",
  "github",
  "transcript",
  "document",
];

/**
 * The Discussions section's list, grouped by where each thread is drawn:
 * detached threads (their code changed or their anchor is gone) first, then
 * Changes, GitHub thread, transcript and document ones, each in creation
 * order. Every thread is listed exactly once.
 */
export function discussionList(
  threads: readonly SelectionThread[]
): Record<ThreadPlace, SelectionThread[]> {
  const groups: Record<ThreadPlace, SelectionThread[]> = {
    detached: [],
    changes: [],
    github: [],
    transcript: [],
    document: [],
  };
  for (const thread of threads) groups[threadPlace(thread)].push(thread);
  return groups;
}

export type ThreadAnchor = Pick<SelectionThread, "id" | "anchor"> & {
  detached: boolean;
};

/**
 * What the diff surfaces draw at an anchor. A GitHub thread's discussion is
 * drawn with that thread instead, so it is never among them.
 */
function drawnAnchors(threads: readonly SelectionThread[]): ThreadAnchor[] {
  return threads
    .filter((thread) => thread.githubThreadId === null)
    .map(({ id, anchor, status }) => ({
      id,
      anchor,
      detached: status.kind !== "inline",
    }));
}

/** Whether a diff surface draws this thread inline: only on its own home. */
export function drawnOn(
  { anchor, detached }: ThreadAnchor,
  surface: ReviewSurface
): boolean {
  const home = anchor.home;
  if (detached || anchor.fullFile || home.kind !== surface.kind) return false;
  return (
    home.kind !== "tool_call" ||
    (surface.kind === "tool_call" && home.toolUseId === surface.toolUseId)
  );
}

export function mergeDiscussion(
  previous: SelectionThread | undefined,
  restored: SelectionThread
): SelectionThread {
  return {
    ...restored,
    sessionId: restored.sessionId ?? previous?.sessionId ?? null,
    outdatedNoted: restored.outdatedNoted || previous?.outdatedNoted === true,
  };
}

export interface DiscussionState {
  selection: CodeSelection | null;
  threads: SelectionThread[];
  activeId: string | null;
  /**
   * A GitHub thread to bring into view: Changes shows it (in the diff or the
   * Review rail) and reports it taken.
   */
  reveal: { githubThreadId: string; nonce: number } | null;
}

export function captureCodeSelection(
  file: FilePatch,
  range: SelectedLineRange,
  home: DiffCommentHome
): CodeSelection | null {
  const span = resolveSelection(
    file,
    { side: range.side ?? "additions", line: range.start },
    { side: range.endSide ?? range.side ?? "additions", line: range.end }
  );
  const rows = span && spanRows(file, span);
  if (!span || !rows) return null;

  const path = canonicalPath(file);
  const lines = rows.map((row) => row.text);
  const code = lines.join("\n");

  return { ...span, path, code, file, home };
}

function sameSelection(
  left: CodeSelection | null,
  right: CodeSelection | null
) {
  if (left === right) return true;
  if (
    !left ||
    !right ||
    left.file !== right.file ||
    left.path !== right.path ||
    left.side !== right.side ||
    left.startLine !== right.startLine ||
    left.endLine !== right.endLine ||
    left.code !== right.code ||
    !sameFullFile(left.fullFile, right.fullFile)
  )
    return false;
  const a = left.home;
  const b = right.home;
  return a.kind === "worktree"
    ? b.kind === "worktree" &&
        a.wholeBranch === b.wholeBranch &&
        a.comparisonIdentity === b.comparisonIdentity
    : b.kind === "tool_call" &&
        a.toolUseId === b.toolUseId &&
        a.toolName === b.toolName;
}

export function selectionLabel(anchor: CodeSelection): string {
  const end = anchor.endLine === anchor.startLine ? "" : `-${anchor.endLine}`;

  return `${anchor.path}:${anchor.startLine}${end}${anchor.fullFile ? "" : ` (${anchor.side})`}`;
}

/** Note sent once, with the first follow-up after the selection changed. */
export const OUTDATED_CONTEXT_NOTE =
  "Note: the selected code has changed since this discussion started, so the original snapshot may be outdated.";

/**
 * The first turn's payload: the anchored selection as JSON (arbitrary code
 * cannot close a fence) and the question. The read-only policy is the
 * session's developer instructions, not part of any turn.
 */
export function discussionFirstTurn(
  anchor: CodeSelection,
  outdated: boolean,
  question: string,
  github?: GithubDiscussionContext
): string {
  const context = {
    path: anchor.path,
    side: anchor.side,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    code: anchor.code,
    outdated,
    ...(github ? { githubThread: github } : {}),
  };

  return `Context: ${JSON.stringify(context)}\nQuestion: ${question}`;
}

/** A follow-up carries only the question, plus a one-time outdated note. */
export function discussionFollowUp(question: string, noteOutdated: boolean) {
  return noteOutdated ? `${OUTDATED_CONTEXT_NOTE}\n\n${question}` : question;
}

/**
 * The text of a thread's next turn. A conversation the provider already
 * holds (live or resumable) receives only the question; otherwise the turn
 * carries the anchored context.
 */
export function discussionTurn(
  thread: SelectionThread,
  continues: boolean,
  question: string,
  /** The GitHub thread it discusses, as last read; a fresh session carries it. */
  github?: GithubDiscussionContext
): { payload: string; notesOutdated: boolean } {
  if (!continues)
    return {
      payload: discussionFirstTurn(
        thread.anchor,
        isOutdated(thread),
        question,
        github
      ),
      notesOutdated: isOutdated(thread),
    };

  const noteOutdated = isOutdated(thread) && !thread.outdatedNoted;

  return {
    payload: discussionFollowUp(question, noteOutdated),
    notesOutdated: noteOutdated,
  };
}

/**
 * One controller belongs to one mounted session/worktree provider. It owns
 * the selection and its anchored threads; each thread's conversation is a
 * read-only chat session driven by the local chat lifecycle.
 */
export class SelectionDiscussions {
  private state: DiscussionState = {
    selection: null,
    threads: [],
    activeId: null,
    reveal: null,
  };

  private snapshot: WorktreeSnapshot | null = null;
  private anchors: readonly ThreadAnchor[] = [];
  private revealNonce = 0;
  /** Unsent follow-up questions, kept while a thread is closed. Not published. */
  private drafts = new Map<string, string>();
  private listeners = new Set<() => void>();

  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  getSnapshot = () => this.state;

  getAnchors = () => this.anchors;

  private publish(state: DiscussionState) {
    this.state = state;
    this.listeners.forEach((listener) => listener());
  }

  select(selection: CodeSelection | null) {
    if (sameSelection(selection, this.state.selection)) return;

    this.publish({ ...this.state, selection });
  }

  ask(
    anchor: CodeSelection,
    id: string,
    { originalCommitId, originalBlobId }: ReviewAnchorIds,
    githubThreadId: string | null = null
  ): string {
    // Capture can publish a catalog event before its command returns.
    if (this.thread(id)) {
      this.publish({ ...this.state, activeId: id });
      return id;
    }

    const thread: SelectionThread = {
      id,
      anchor,
      git: { original: anchor, capture: { originalCommitId, originalBlobId } },
      status: { kind: "inline" },
      outdatedNoted: false,
      sessionId: null,
      githubThreadId,
    };
    const threads = [...this.state.threads, thread];
    const nextState = { ...this.state, activeId: id, threads };

    this.anchors = drawnAnchors(threads);
    this.publish(nextState);

    return id;
  }

  restore(restored: readonly SelectionThread[]) {
    const byId = new Map(
      this.state.threads.map((thread) => [thread.id, thread])
    );
    for (const thread of restored)
      byId.set(thread.id, mergeDiscussion(byId.get(thread.id), thread));
    if (restored.length) this.publishThreads([...byId.values()]);
  }

  private publishThreads(threads: SelectionThread[]) {
    this.anchors = drawnAnchors(threads);
    this.publish({ ...this.state, threads });
  }

  remove(id: string) {
    const thread = this.thread(id);
    if (!thread) return undefined;
    this.drafts.delete(id);
    if (this.state.activeId === id) {
      this.state = {
        ...this.state,
        activeId: null,
        selection:
          this.state.selection === thread.anchor ? null : this.state.selection,
      };
    }
    this.publishThreads(this.state.threads.filter((item) => item.id !== id));
    return thread;
  }

  reopen(id: string | null) {
    const thread = this.state.threads.find((thread) => thread.id === id);

    if (id === null || thread)
      this.publish({
        ...this.state,
        activeId: id,
        // A GitHub thread's discussion highlights nothing: GitHub places it.
        selection:
          thread?.status.kind === "inline" && thread.githubThreadId === null
            ? thread.anchor
            : this.state.selection,
      });
  }

  /** Open a GitHub thread's discussion and ask Changes to show its thread. */
  reveal(id: string) {
    const githubThreadId = this.thread(id)?.githubThreadId;
    if (!githubThreadId) return;
    this.publish({
      ...this.state,
      activeId: id,
      reveal: { githubThreadId, nonce: ++this.revealNonce },
    });
  }

  /** Ask Changes to show a GitHub thread that was sent without discussion. */
  revealGithub(githubThreadId: string) {
    this.publish({
      ...this.state,
      reveal: { githubThreadId, nonce: ++this.revealNonce },
    });
  }

  /** Changes showed the thread `reveal` asked for. */
  revealed(nonce: number) {
    if (this.state.reveal?.nonce === nonce)
      this.publish({ ...this.state, reveal: null });
  }

  /** The discussion of a GitHub review thread, if there is one. */
  forGithubThread(githubThreadId: string): SelectionThread | undefined {
    return this.state.threads.find(
      (thread) => thread.githubThreadId === githubThreadId
    );
  }

  draft(id: string): string {
    return this.drafts.get(id) ?? "";
  }

  setDraft(id: string, text: string) {
    if (text) this.drafts.set(id, text);
    else this.drafts.delete(id);
  }

  thread(id: string): SelectionThread | undefined {
    return this.state.threads.find((thread) => thread.id === id);
  }

  private update(
    id: string,
    update: (thread: SelectionThread) => SelectionThread
  ) {
    const threads = this.state.threads.map((thread) =>
      thread.id === id ? update(thread) : thread
    );

    this.publish({ ...this.state, threads });
  }

  /** Record a turn sent in `sessionId`, which now holds the conversation. */
  sent(id: string, sessionId: string, notedOutdated: boolean) {
    this.update(id, (thread) => ({
      ...thread,
      sessionId,
      outdatedNoted: thread.outdatedNoted || notedOutdated,
    }));
  }

  applyMappings(
    snapshot: WorktreeSnapshot | null,
    mappings: readonly MappedReviewThread[]
  ) {
    if (this.snapshot !== snapshot) return;
    const positions = new Map(mappings.map((row) => [row.threadId, row]));
    const threads = this.state.threads.map((thread) => {
      const position = positions.get(thread.id);
      // A GitHub thread's discussion follows GitHub's anchor, not its own.
      if (
        !position ||
        thread.githubThreadId !== null ||
        thread.status.kind === "unreadable" ||
        thread.git.original.home.kind !== "worktree"
      )
        return thread;
      const original = thread.git.original;
      const file = original.fullFile
        ? undefined
        : snapshot?.files.find((file) =>
            original.side === "old"
              ? file.oldPath === original.file.oldPath
              : file.newPath === original.path
          );
      if (position.status === "unavailable")
        return {
          ...thread,
          status: {
            kind: "unavailable",
            lastKnown: isOutdated(thread) ? "outdated" : "open",
          },
        } satisfies SelectionThread;
      const outdated = position.status === "outdated";
      const anchor =
        outdated || position.startLine === null || position.line === null
          ? original
          : {
              ...original,
              file: file ?? original.file,
              path: file ? canonicalPath(file) : original.path,
              startLine: position.startLine,
              endLine: position.line,
            };
      return {
        ...thread,
        anchor,
        status: {
          kind: outdated
            ? "outdated"
            : original.fullFile || (file && spanRows(file, anchor))
              ? "inline"
              : "detached",
        },
      } satisfies SelectionThread;
    });

    this.publishThreads(threads);
  }

  reconcile(snapshot: WorktreeSnapshot) {
    this.snapshot = snapshot;

    const selection = this.state.selection;
    if (selection?.home.kind !== "worktree" || selection.fullFile) return;

    const file = snapshot.files.find(
      (file) => canonicalPath(file) === selection.path
    );
    if (
      !file ||
      spanRows(file, selection)
        ?.map((row) => row.text)
        .join("\n") !== selection.code
    )
      this.publish({ ...this.state, selection: null });
  }
}

/** The badge a thread shows when its anchor is no longer reliable. */
export function anchorNotice(status: ThreadStatus) {
  switch (status.kind) {
    case "inline":
    case "detached":
      return null;
    case "outdated":
      return { marker: "outdated", label: "Outdated context" };
    case "unavailable":
    case "unreadable":
      return { marker: "anchor unavailable", label: "Anchor unavailable" };
  }
}
