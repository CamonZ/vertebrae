import type { CapturedReviewAnchor, MappedReviewThread } from "../../bindings";
import type { SelectedLineRange } from "@pierre/diffs";
import type { DiffCommentHome } from "./assistantTextComments";
import {
  canonicalPath,
  resolveSelection,
  spanRows,
  type FilePatch,
  type LineSpan,
} from "../thread/toolChange/diffLineMapper";
import type { WorktreeSnapshot } from "../thread/toolChange/diffComments";

export interface CodeSelection extends LineSpan {
  path: string;
  code: string;
  file: FilePatch;
  home: DiffCommentHome;
}

export interface SelectionThread {
  id: string;
  anchor: CodeSelection;
  status: ThreadStatus;
  git: { original: CodeSelection; capture: CapturedReviewAnchor };
  /** Whether the agent has been told the context is outdated. */
  outdatedNoted: boolean;

  /** The read-only chat session the conversation runs in, once asked. */
  sessionId: string | null;
}

export type ThreadStatus =
  | { kind: "inline" | "detached" | "outdated" }
  | { kind: "unreadable"; message: string }
  | { kind: "unavailable"; lastKnown: "open" | "outdated" };

export function isOutdated({ status }: SelectionThread): boolean {
  return status.kind === "outdated" ||
    (status.kind === "unavailable" && status.lastKnown === "outdated");
}

export type ThreadAnchor = Pick<SelectionThread, "id" | "anchor"> & { detached: boolean };

export function mergeDiscussion(previous: SelectionThread | undefined, restored: SelectionThread): SelectionThread {
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

function sameSelection(left: CodeSelection | null, right: CodeSelection | null) {
  if (left === right) return true;
  if (!left || !right || left.file !== right.file || left.path !== right.path ||
      left.side !== right.side || left.startLine !== right.startLine ||
      left.endLine !== right.endLine || left.code !== right.code) return false;
  const a = left.home;
  const b = right.home;
  return a.kind === "worktree"
    ? b.kind === "worktree" && a.wholeBranch === b.wholeBranch && a.comparisonIdentity === b.comparisonIdentity
    : b.kind === "tool_call" && a.toolUseId === b.toolUseId && a.toolName === b.toolName;
}

export function selectionLabel(anchor: CodeSelection): string {
  const end = anchor.endLine === anchor.startLine ? "" : `-${anchor.endLine}`;

  return `${anchor.path}:${anchor.startLine}${end} (${anchor.side})`;
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
  question: string
): string {
  const context = {
    path: anchor.path,
    side: anchor.side,
    startLine: anchor.startLine,
    endLine: anchor.endLine,
    code: anchor.code,
    outdated,
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
  question: string
): { payload: string; notesOutdated: boolean } {
  if (!continues)
    return {
      payload: discussionFirstTurn(thread.anchor, isOutdated(thread), question),
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
  };

  private snapshot: WorktreeSnapshot | null = null;
  private anchors: readonly ThreadAnchor[] = [];
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
    capture: CapturedReviewAnchor
  ): string {
    // Capture can publish a catalog event before its command returns.
    if (this.thread(id)) {
      this.publish({ ...this.state, activeId: id });
      return id;
    }

    const thread: SelectionThread = {
      id,
      anchor,
      git: { original: anchor, capture },
      status: { kind: "inline" },
      outdatedNoted: false,
      sessionId: null,
    };
    const threads = [...this.state.threads, thread];
    const nextState = { ...this.state, activeId: id, threads };

    this.anchors = [...this.anchors, { id, anchor, detached: false }];
    this.publish(nextState);

    return id;
  }

  restore(restored: readonly SelectionThread[]) {
    const byId = new Map(this.state.threads.map((thread) => [thread.id, thread]));
    for (const thread of restored) byId.set(thread.id, mergeDiscussion(byId.get(thread.id), thread));
    if (restored.length) this.publishThreads([...byId.values()]);
  }

  private publishThreads(threads: SelectionThread[]) {
    this.anchors = threads.map(({ id, anchor, status }) => ({
      id, anchor, detached: status.kind !== "inline",
    }));
    this.publish({ ...this.state, threads });
  }

  remove(id: string) {
    const thread = this.thread(id);
    if (!thread) return undefined;
    if (this.state.activeId === id) {
      this.state = {
        ...this.state,
        activeId: null,
        selection: this.state.selection === thread.anchor ? null : this.state.selection,
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
        selection: thread?.status.kind === "inline" ? thread.anchor : this.state.selection,
      });
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
    snapshot: WorktreeSnapshot,
    mappings: readonly MappedReviewThread[]
  ) {
    if (this.snapshot !== snapshot) return;
    const positions = new Map(mappings.map((row) => [row.threadId, row]));
    const threads = this.state.threads.map((thread) => {
      const position = positions.get(thread.id);
      if (!position || thread.status.kind === "unreadable" || thread.git.original.home.kind !== "worktree") return thread;
      const original = thread.git.original;
      const file = snapshot.files.find((file) =>
        original.side === "old"
          ? file.oldPath === original.file.oldPath
          : file.newPath === original.path
      );
      if (position.status === "unavailable")
        return { ...thread, status: { kind: "unavailable", lastKnown: isOutdated(thread) ? "outdated" : "open" } } satisfies SelectionThread;
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
        status: { kind: outdated ? "outdated" : file && spanRows(file, anchor) ? "inline" : "detached" },
      } satisfies SelectionThread;
    });

    this.publishThreads(threads);
  }

  reconcile(snapshot: WorktreeSnapshot) {
    this.snapshot = snapshot;

    const selection = this.state.selection;
    if (selection?.home.kind !== "worktree") return;

    const file = snapshot.files.find((file) => canonicalPath(file) === selection.path);
    if (!file || spanRows(file, selection)?.map((row) => row.text).join("\n") !== selection.code)
      this.publish({ ...this.state, selection: null });
  }
}
