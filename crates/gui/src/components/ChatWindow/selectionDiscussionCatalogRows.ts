import type { ReviewThread } from "../../bindings";

interface CatalogEntry {
  row?: ReviewThread | null;
  event: number;
}

/** A list response cannot overwrite events received while it was in flight. */
export class SelectionDiscussionCatalogRows {
  private entries = new Map<string, CatalogEntry>();
  private event = 0;

  checkpoint() {
    return this.event;
  }

  includesSnapshotRow(id: string, checkpoint: number) {
    const entry = this.entries.get(id);
    return !entry || (entry.row !== null && entry.event <= checkpoint);
  }

  row(id: string) {
    return this.entries.get(id)?.row ?? undefined;
  }

  isDeleted(id: string) {
    return this.entries.get(id)?.row === null;
  }

  recordEvent(id: string) {
    const entry = this.entries.get(id);
    this.entries.set(id, { row: entry?.row, event: ++this.event });
  }

  set(row: ReviewThread) {
    this.entries.set(row.threadId, {
      row,
      event: this.entries.get(row.threadId)?.event ?? 0,
    });
  }

  delete(id: string) {
    this.entries.set(id, { row: null, event: ++this.event });
  }
}
