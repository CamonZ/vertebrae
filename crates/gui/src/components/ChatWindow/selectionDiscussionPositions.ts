import type { ReviewThreadPosition } from "../../bindings";
import type { SelectionThread } from "./selectionDiscussions";

export function samePosition(
  left: ReviewThreadPosition,
  right: ReviewThreadPosition
) {
  return (
    left.status === right.status &&
    left.startLine === right.startLine &&
    left.line === right.line
  );
}

export function mappedPosition(
  thread: SelectionThread
): ReviewThreadPosition | undefined {
  switch (thread.status.kind) {
    case "unavailable":
    case "unreadable":
      return undefined;
    case "outdated":
      return { status: "outdated", startLine: null, line: null };
    case "inline":
    case "detached":
      return {
        status: "open",
        startLine: thread.anchor.startLine,
        line: thread.anchor.endLine,
      };
  }
}

export interface PositionWrite {
  position: ReviewThreadPosition;
  acknowledged: boolean;
}

interface PendingPosition {
  writing?: PositionWrite;
  awaitingEvent?: PositionWrite;
  queued?: ReviewThreadPosition;
}

/** Invokes serialize writes. Catalog events acknowledge them independently. */
export class SelectionDiscussionPositions {
  private pending = new Map<string, PendingPosition>();

  stage(
    id: string,
    stored: ReviewThreadPosition,
    position?: ReviewThreadPosition
  ) {
    const entry = this.pending.get(id) ?? {};
    if (entry.writing) {
      entry.queued = position;
      return undefined;
    }
    return this.start(id, entry, stored, position);
  }

  private start(
    id: string,
    entry: PendingPosition,
    stored: ReviewThreadPosition,
    position?: ReviewThreadPosition
  ) {
    const base = entry.awaitingEvent?.position ?? stored;
    if (!position || samePosition(position, base)) return undefined;
    const write: PositionWrite = { position, acknowledged: false };
    entry.writing = write;
    this.pending.set(id, entry);
    return write;
  }

  finish(
    id: string,
    stored: ReviewThreadPosition,
    write: PositionWrite,
    succeeded: boolean
  ) {
    const entry = this.pending.get(id);
    if (!entry || entry.writing !== write) return undefined;
    entry.writing = undefined;
    if (succeeded) entry.awaitingEvent = write.acknowledged ? undefined : write;
    const next = this.start(id, entry, stored, entry.queued);
    entry.queued = undefined;
    this.prune(id, entry);
    return next;
  }

  observe(id: string, stored: ReviewThreadPosition) {
    const entry = this.pending.get(id);
    if (!entry) return;
    if (entry.writing && samePosition(entry.writing.position, stored)) {
      entry.writing.acknowledged = true;
    }
    if (
      entry.awaitingEvent &&
      samePosition(entry.awaitingEvent.position, stored)
    ) {
      entry.awaitingEvent = undefined;
    }
    this.prune(id, entry);
  }

  preservesProjection(id: string) {
    const entry = this.pending.get(id);
    return !!(entry?.writing || entry?.awaitingEvent);
  }

  remove(id: string) {
    this.pending.delete(id);
  }

  private prune(id: string, entry: PendingPosition) {
    if (!entry.writing && !entry.awaitingEvent) this.pending.delete(id);
  }
}
