import type { SessionLog } from "../bindings";
import type { SessionLogPerformanceCorrelation } from "./sessionLogPerformance";
import { SESSION_LOG_FLUSH_POLICY } from "./sessionLogPerformance";

export type SessionLogChangeOperation = "append" | "upsert";

export interface QueuedSessionLogEvent {
  executionId: string;
  log: SessionLog;
  operation: SessionLogChangeOperation;
  urgent: boolean;
  correlation?: SessionLogPerformanceCorrelation;
}

export interface SessionLogEventQueueOptions {
  onFlush: (events: readonly QueuedSessionLogEvent[]) => void;
  onQueued?: (event: QueuedSessionLogEvent, pendingCount: number) => void;
  onOverflow?: () => void;
  maxBatchSize?: number;
  maxPendingRecords?: number;
  requestAnimationFrame?: (callback: () => void) => number;
  cancelAnimationFrame?: (handle: number) => void;
  setTimeout?: (callback: () => void, delayMs: number) => ReturnType<typeof setTimeout>;
  clearTimeout?: (handle: ReturnType<typeof setTimeout>) => void;
}

const activeQueues = new Set<SessionLogEventQueue>();

/**
 * Drain every live queue before project-scoped state is reset. This preserves
 * records for the old project before its store is cleared and prevents a
 * scheduled callback from writing into the next project scope.
 */
export function flushSessionLogEventQueues(): void {
  for (const queue of [...activeQueues]) queue.flushNow();
}

/** Harness event types that must not wait for the ordinary frame/timer cadence. */
export function isUrgentSessionLog(log: SessionLog): boolean {
  const content = log.content ?? "";
  return /"(?:type|event_type)"\s*:\s*"(?:run_finished|turn_finished|error)"/.test(
    content
  );
}

function defaultRequestAnimationFrame():
  | ((callback: () => void) => number)
  | undefined {
  if (typeof globalThis.requestAnimationFrame !== "function") return undefined;
  return globalThis.requestAnimationFrame.bind(globalThis);
}

function defaultCancelAnimationFrame(): ((handle: number) => void) | undefined {
  if (typeof globalThis.cancelAnimationFrame !== "function") return undefined;
  return globalThis.cancelAnimationFrame.bind(globalThis);
}

export class SessionLogEventQueue {
  private readonly pending: QueuedSessionLogEvent[] = [];
  private readonly onFlush: SessionLogEventQueueOptions["onFlush"];
  private readonly onQueued: NonNullable<SessionLogEventQueueOptions["onQueued"]>;
  private readonly onOverflow: NonNullable<SessionLogEventQueueOptions["onOverflow"]>;
  private readonly maxBatchSize: number;
  private readonly maxPendingRecords: number;
  private readonly requestAnimationFrame?: (callback: () => void) => number;
  private readonly cancelAnimationFrame?: (handle: number) => void;
  private readonly setTimeout: NonNullable<SessionLogEventQueueOptions["setTimeout"]>;
  private readonly clearTimeout: NonNullable<SessionLogEventQueueOptions["clearTimeout"]>;
  private frameHandle: number | null = null;
  private timerHandle: ReturnType<typeof setTimeout> | null = null;
  private urgent = false;
  private disposed = false;

  constructor(options: SessionLogEventQueueOptions) {
    this.onFlush = options.onFlush;
    this.onQueued = options.onQueued ?? (() => {});
    this.onOverflow = options.onOverflow ?? (() => {});
    this.maxBatchSize = options.maxBatchSize ?? SESSION_LOG_FLUSH_POLICY.maxBatchSize;
    this.maxPendingRecords =
      options.maxPendingRecords ?? SESSION_LOG_FLUSH_POLICY.maxPendingRecords;
    this.requestAnimationFrame =
      options.requestAnimationFrame ?? defaultRequestAnimationFrame();
    this.cancelAnimationFrame =
      options.cancelAnimationFrame ?? defaultCancelAnimationFrame();
    this.setTimeout = options.setTimeout ?? globalThis.setTimeout.bind(globalThis);
    this.clearTimeout = options.clearTimeout ?? globalThis.clearTimeout.bind(globalThis);
    activeQueues.add(this);
  }

  get pendingCount(): number {
    return this.pending.length;
  }

  enqueue(event: QueuedSessionLogEvent): boolean {
    if (this.disposed) return false;
    if (this.pending.length >= this.maxPendingRecords) {
      this.onOverflow();
      this.flushNow();
    }
    if (this.disposed) return false;
    this.pending.push(event);
    this.onQueued(event, this.pending.length);
    if (event.urgent) this.urgent = true;
    this.schedule();
    return true;
  }

  flushNow(): void {
    if (this.disposed || this.pending.length === 0) return;
    this.cancelScheduledWork();
    this.flushPending(true);
  }

  dispose(options: { flush?: boolean } = {}): void {
    if (this.disposed) return;
    const shouldFlush = options.flush ?? true;
    if (shouldFlush) this.flushNow();
    this.disposed = true;
    this.cancelScheduledWork();
    activeQueues.delete(this);
    this.pending.length = 0;
  }

  private schedule(): void {
    if (this.disposed || this.pending.length === 0) return;
    if (this.frameHandle === null && this.requestAnimationFrame) {
      this.frameHandle = this.requestAnimationFrame(() => {
        this.frameHandle = null;
        this.clearTimer();
        this.flushScheduled();
      });
    }

    const delay = this.urgent
      ? SESSION_LOG_FLUSH_POLICY.terminalFlushIntervalMs
      : SESSION_LOG_FLUSH_POLICY.maxFlushIntervalMs;
    if (this.timerHandle === null || this.urgent) {
      this.clearTimer();
      this.timerHandle = this.setTimeout(() => {
        this.timerHandle = null;
        this.cancelFrame();
        this.flushScheduled();
      }, delay);
    }
  }

  private flushScheduled(): void {
    if (this.disposed || this.pending.length === 0) return;
    const drainAll = this.urgent;
    this.urgent = false;
    this.flushPending(drainAll);
    if (this.pending.length > 0) this.schedule();
  }

  private flushPending(drainAll: boolean): void {
    const count = drainAll
      ? this.pending.length
      : Math.min(this.pending.length, this.maxBatchSize);
    const batch = this.pending.splice(0, count);
    this.urgent = false;
    try {
      this.onFlush(batch);
    } catch (error) {
      this.pending.unshift(...batch);
      this.urgent = true;
      this.schedule();
      throw error;
    }
  }

  private cancelFrame(): void {
    if (this.frameHandle === null) return;
    this.cancelAnimationFrame?.(this.frameHandle);
    this.frameHandle = null;
  }

  private clearTimer(): void {
    if (this.timerHandle === null) return;
    this.clearTimeout(this.timerHandle);
    this.timerHandle = null;
  }

  private cancelScheduledWork(): void {
    this.cancelFrame();
    this.clearTimer();
  }
}

export function createSessionLogEventQueue(
  options: SessionLogEventQueueOptions
): SessionLogEventQueue {
  return new SessionLogEventQueue(options);
}
