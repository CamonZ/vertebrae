/**
 * UnifiedChatView — the TRACES stream over a SINGLE task_run.
 *
 * Renders the run's `Thread[]` through the shared recursive <Thread> primitive
 * in timed/deep/read-only mode (step heads + intra-run subagent nesting). When
 * `focused` is set (focus-drill) it renders that single subthread instead of
 * the whole run.
 *
 * Data is normalize-on-render: TracesPage memoizes `runToThreads(...)` and
 * passes the resulting Thread[] down — this component owns no fetching.
 */

import {
  useCallback,
  useLayoutEffect,
  useMemo,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";

import { Thread } from "../thread/Thread";
import type { Thread as ThreadModel } from "../thread/types";
import { HumanInputGate } from "./HumanInputGate";
import type { HumanInputGateContext } from "../../utils/humanInputGate";

interface UnifiedChatViewProps {
  /** The run's root threads (one per step execution). */
  threads: ThreadModel[];
  isLoading?: boolean;
  error?: string | null;
  /** Currently selected evt / thread id. */
  selectedEvt?: string | null;
  /** Select an evt / thread id. */
  onSelect?: (id: string) => void;
  /** Focus-drill into a subthread. */
  onFocus?: (thread: ThreadModel) => void;
  /** When set, render only this focused subthread. */
  focused?: ThreadModel | null;
  /** Auto-scroll to the bottom as new messages append. */
  autoScroll?: boolean;
  /** Optional waiting-run gate to surface above the stream. */
  humanInputGate?: HumanInputGateContext | null;
  /** Scroll container ref (mirrored by the FlightStrip). */
  scrollRef?: RefObject<HTMLDivElement | null>;
  activeRunStoppable?: boolean;
  isStoppingActiveRun?: boolean;
  onStopActiveRun?: () => void;
}

/** Total message count across a thread tree (auto-scroll trigger). */
function countMessages(threads: ThreadModel[]): number {
  let n = 0;
  const walk = (t: ThreadModel): void => {
    for (const turn of t.turns ?? []) {
      for (const m of turn.messages ?? []) {
        n += 1;
        if (m.type === "spawn") walk(m.thread);
      }
    }
  };
  threads.forEach(walk);
  return n;
}

export function UnifiedChatView({
  threads,
  isLoading = false,
  error = null,
  selectedEvt = null,
  onSelect,
  onFocus,
  focused = null,
  autoScroll = false,
  humanInputGate = null,
  scrollRef,
  activeRunStoppable = false,
  isStoppingActiveRun = false,
  onStopActiveRun,
}: UnifiedChatViewProps): ReactNode {
  const internalScrollRef = useRef<HTMLDivElement | null>(null);
  const setScrollEl = useCallback(
    (el: HTMLDivElement | null) => {
      internalScrollRef.current = el;
      if (scrollRef) {
        (scrollRef as { current: HTMLDivElement | null }).current = el;
      }
    },
    [scrollRef]
  );

  // Register thread DOM nodes so the rail / flight-strip can scroll to them.
  // The frozen primitive registers thread ids via registerRef; we tag the
  // element with a data attribute so the surface (and FlightStrip) can find it.
  const registerRef = useCallback((id: string, el: HTMLElement | null) => {
    if (el) el.setAttribute("data-thread-id", id);
  }, []);

  const messageCount = useMemo(() => countMessages(threads), [threads]);
  const lastCountRef = useRef(messageCount);
  useLayoutEffect(() => {
    const prev = lastCountRef.current;
    lastCountRef.current = messageCount;
    if (!autoScroll) return;
    if (messageCount <= prev) return;
    const el = internalScrollRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messageCount, autoScroll]);

  if (error) {
    return (
      <div
        data-testid="unified-chat-error"
        className="m-4 rounded-[var(--radius-md)] border border-[var(--color-err)]/40 bg-[var(--color-err-wash)] p-4 text-sm text-[var(--color-err)]"
      >
        Failed to load conversation: {error}
      </div>
    );
  }

  if (isLoading && threads.length === 0) {
    return (
      <div
        data-testid="unified-chat-loading"
        className="flex h-full items-center justify-center p-8 text-sm text-[var(--color-fg-mute)]"
      >
        <span className="inline-block h-4 w-4 animate-spin rounded-full border-2 border-[var(--color-fg-mute)] border-t-transparent" />
        <span className="ml-2">Loading conversation…</span>
      </div>
    );
  }

  const gateNode = humanInputGate ? (
    <div className="px-4 pt-2">
      <HumanInputGate
        context={humanInputGate}
        stoppable={activeRunStoppable}
        isStopping={isStoppingActiveRun}
        onStop={onStopActiveRun}
      />
    </div>
  ) : null;

  const empty = threads.length === 0 && !focused;

  return (
    <div
      ref={setScrollEl}
      data-testid="unified-chat-view"
      data-auto-scroll={autoScroll ? "1" : "0"}
      className="evlog evlog--timed relative h-full overflow-x-hidden overflow-y-auto bg-[var(--color-bg)] px-4 py-3"
    >
      {gateNode}
      {empty ? (
        <div
          data-testid="unified-chat-empty"
          className="flex flex-col items-center justify-center p-8 text-center text-sm text-[var(--color-fg-mute)]"
        >
          No conversation yet for this run.
        </div>
      ) : focused ? (
        <Thread
          key={focused.id}
          thread={focused}
          depth={0}
          mode="timed"
          reveal="deep"
          readOnly
          selectedEvt={selectedEvt}
          onSelect={onSelect}
          registerRef={registerRef}
          onFocus={onFocus}
        />
      ) : (
        threads.map((th) => (
          <Thread
            key={th.id}
            thread={th}
            depth={0}
            mode="timed"
            reveal="deep"
            readOnly
            selectedEvt={selectedEvt}
            onSelect={onSelect}
            registerRef={registerRef}
            onFocus={onFocus}
          />
        ))
      )}
    </div>
  );
}
