import type { LocalChatTextEvent } from "../bindings";

const activeFlushers = new Set<() => void>();

/** Flush accepted IPC text before local cancellation or session retirement. */
export function flushPendingLocalChatText() {
  for (const flush of activeFlushers) flush();
}

const PUBLICATION_INTERVAL_MS = 32;
const MAX_PENDING_CHARS = 64 * 1024;
const MAX_PENDING_EVENTS = 128;

function identity(event: LocalChatTextEvent): string {
  return JSON.stringify([
    event.backend_session_id,
    event.harness,
    event.thread_id,
    event.turn_id,
    event.item_id,
    event.parent_tool_use_id,
    event.is_root,
  ]);
}

/** Subscription-owned, lossless queue. Semantic events call flush before routing. */
export function createLocalChatTextBatch(
  publish: (event: LocalChatTextEvent) => void
) {
  let disposed = false;
  let pending: LocalChatTextEvent[] = [];
  let chars = 0;
  let count = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const flush = () => {
    clearTimeout(timer);
    timer = undefined;

    const batch = pending;
    pending = [];
    chars = 0;
    count = 0;

    for (const event of batch) publish(event);
  };

  activeFlushers.add(flush);

  return {
    flush,

    dispose() {
      disposed = true;
      flush();
      activeFlushers.delete(flush);
    },

    push(event: LocalChatTextEvent) {
      if (disposed) return;

      // Legacy unkeyed partials have different merge semantics. Keep that path synchronous.
      if (!event.is_partial || !event.item_id) {
        flush();
        publish(event);
        return;
      }

      if (
        chars + event.text.length > MAX_PENDING_CHARS ||
        count === MAX_PENDING_EVENTS
      )
        flush();

      // A single large event need not be copied into a delayed buffer.
      if (event.text.length >= MAX_PENDING_CHARS) {
        publish(event);
        return;
      }

      const last = pending[pending.length - 1];
      if (last && identity(last) === identity(event)) {
        pending[pending.length - 1] = { ...last, text: last.text + event.text };
      } else pending.push({ ...event });

      chars += event.text.length;
      count++;
      timer ??= setTimeout(flush, PUBLICATION_INTERVAL_MS);
    },
  };
}
