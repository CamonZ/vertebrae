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
  outdated: boolean;
  /** Whether the agent has been told the context is outdated. */
  outdatedNoted: boolean;
  /** The read-only chat session the conversation runs in, once asked. */
  sessionId: string | null;
}

export type ThreadAnchor = Pick<SelectionThread, "id" | "anchor">;

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
      payload: discussionFirstTurn(thread.anchor, thread.outdated, question),
      notesOutdated: thread.outdated,
    };

  const noteOutdated = thread.outdated && !thread.outdatedNoted;

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
    const nextSelection = JSON.stringify(selection);
    const currentSelection = JSON.stringify(this.state.selection);
    if (nextSelection === currentSelection) return;

    this.publish({ ...this.state, selection });
  }

  ask(): string | null {
    if (!this.state.selection) return null;

    const id = crypto.randomUUID();
    const thread: SelectionThread = {
      id,
      anchor: this.state.selection,
      outdated: false,
      outdatedNoted: false,
      sessionId: null,
    };
    const threads = [...this.state.threads, thread];
    const nextState = { ...this.state, activeId: id, threads };

    this.anchors = [...this.anchors, { id, anchor: this.state.selection }];
    this.publish(nextState);

    return id;
  }

  reopen(id: string | null) {
    const thread = this.state.threads.find((thread) => thread.id === id);

    if (id === null || thread)
      this.publish({
        ...this.state,
        activeId: id,
        selection: thread?.anchor ?? this.state.selection,
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

  reconcile(snapshot: WorktreeSnapshot) {
    const previous = this.snapshot;
    this.snapshot = snapshot;

    const patchFor = (snapshot: WorktreeSnapshot | null, path: string) =>
      snapshot?.files.find((file) => canonicalPath(file) === path);
    let selection = this.state.selection;

    if (selection?.home.kind === "worktree") {
      const currentFile = patchFor(snapshot, selection.path);
      const currentPatch = JSON.stringify(currentFile);
      const selectedPatch = JSON.stringify(selection.file);

      if (currentPatch !== selectedPatch) selection = null;
    }

    const threads = this.state.threads.map((thread) => {
      const anchor = thread.anchor;
      const currentFile = patchFor(snapshot, anchor.path);
      const currentPatch = JSON.stringify(currentFile);
      let outdated: boolean;

      if (anchor.home.kind === "worktree") {
        const selectedPatch = JSON.stringify(anchor.file);
        const comparisonChanged =
          anchor.home.comparisonIdentity !== snapshot.comparisonIdentity;

        outdated = currentPatch !== selectedPatch || comparisonChanged;
      } else {
        const previousFile = patchFor(previous, anchor.path);
        const previousPatch = JSON.stringify(previousFile);

        outdated = previous !== null && previousPatch !== currentPatch;
      }

      return outdated && !thread.outdated
        ? { ...thread, outdated: true }
        : thread;
    });
    const nextState = { ...this.state, selection, threads };

    this.publish(nextState);
  }
}
