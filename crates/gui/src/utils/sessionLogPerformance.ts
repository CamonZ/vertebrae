/**
 * Frontend-only pacing and measurement contract for live session-log events.
 *
 * This module is deliberately disabled by default. Hot-path callers should
 * guard correlation construction and recording with `monitor.enabled` so the
 * normal production path does not allocate diagnostic state per event.
 */

export const SESSION_LOG_FLUSH_POLICY = Object.freeze({
  /** Preferred cadence when requestAnimationFrame is available. */
  animationFrameMs: 16,
  /** Maximum time an ordinary queued event may wait before a flush. */
  maxFlushIntervalMs: 50,
  /** Terminal/error records use the next frame rather than waiting for the timer. */
  terminalFlushIntervalMs: 16,
  /** A single store application is bounded even when the queue is larger. */
  maxBatchSize: 256,
  /** Overflow forces reconciliation before another record is accepted. */
  maxPendingRecords: 4096,
  /** Soft observation budget; hot-state eviction is not enabled by this contract. */
  hotStateRecordBudget: 10_000,
  /** Initial responsiveness target for received-to-visible work. */
  eventToVisibleLatencyBudgetMs: 100,
  /** Bound diagnostic sample memory when stress instrumentation is enabled. */
  maxLatencySamples: 2048,
});

export type SessionLogFlushPolicy = typeof SESSION_LOG_FLUSH_POLICY;

export interface SessionLogPerformanceCorrelation {
  /** Project-scope generation or another caller-owned stable scope identity. */
  projectScope: string;
  executionId: string;
  /** Stable live record identity, normally id or logical_key. */
  recordKey: string;
}

export interface SessionLogPerformanceScope {
  projectScope: string;
  executionId?: string;
}

export interface SessionLogPerformanceMetrics {
  eventsReceived: number;
  eventsQueued: number;
  eventsVisible: number;
  eventsFlushed: number;
  storeCommits: number;
  rollupRuns: number;
  rollupRecordsProcessed: number;
  renderCommits: number;
  storeUpdateTimeMs: number;
  rollupTimeMs: number;
  queueDepth: number;
  maxQueueDepth: number;
  maxBatchSize: number;
  retainedRecords: number;
  overflowReconciliations: number;
  memoryUsedBytes: number | null;
  eventToVisibleLatencyMs: {
    count: number;
    p50: number | null;
    p95: number | null;
    max: number | null;
  };
}

export interface SessionLogPerformanceSnapshot {
  enabled: boolean;
  policy: SessionLogFlushPolicy;
  project: SessionLogPerformanceMetrics;
  executions: Record<string, SessionLogPerformanceMetrics>;
}

export interface SessionLogPerformanceMonitor {
  readonly enabled: boolean;
  setEnabled(enabled: boolean): void;
  reset(): void;
  snapshot(): SessionLogPerformanceSnapshot;
  recordReceived(
    correlation: SessionLogPerformanceCorrelation,
    receivedAt?: number
  ): void;
  recordQueued(scope: SessionLogPerformanceScope, queueDepth: number): void;
  recordFlush(
    scope: SessionLogPerformanceScope,
    batchSize: number,
    durationMs?: number
  ): void;
  recordVisible(
    correlation: SessionLogPerformanceCorrelation,
    visibleAt?: number
  ): void;
  recordRollup(
    scope: SessionLogPerformanceScope,
    recordsProcessed: number,
    durationMs?: number
  ): void;
  recordRender(scope: SessionLogPerformanceScope): void;
  recordRetainedRecords(scope: SessionLogPerformanceScope, count: number): void;
  recordOverflowReconciliation(scope: SessionLogPerformanceScope): void;
}

export interface SessionLogPerformanceCorrelationInput {
  projectScope: string;
  executionId: string;
  logId?: string | null;
  logicalKey?: string | null;
}

/**
 * Build a stable diagnostic identity without changing the SessionLog itself.
 * Logical keys take precedence because an updated ephemeral snapshot can have
 * a different database id while still representing the same UI record.
 */
export function makeSessionLogPerformanceCorrelation({
  projectScope,
  executionId,
  logId,
  logicalKey,
}: SessionLogPerformanceCorrelationInput): SessionLogPerformanceCorrelation {
  const recordKey = logicalKey
    ? `logical:${logicalKey}`
    : logId
      ? `id:${logId}`
      : "unknown";
  return { projectScope, executionId, recordKey };
}

function nowMs(): number {
  return typeof performance !== "undefined" ? performance.now() : Date.now();
}

function nonNegative(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function emptyMetrics(): SessionLogPerformanceMetrics {
  return {
    eventsReceived: 0,
    eventsQueued: 0,
    eventsVisible: 0,
    eventsFlushed: 0,
    storeCommits: 0,
    rollupRuns: 0,
    rollupRecordsProcessed: 0,
    renderCommits: 0,
    storeUpdateTimeMs: 0,
    rollupTimeMs: 0,
    queueDepth: 0,
    maxQueueDepth: 0,
    maxBatchSize: 0,
    retainedRecords: 0,
    overflowReconciliations: 0,
    memoryUsedBytes: null,
    eventToVisibleLatencyMs: {
      count: 0,
      p50: null,
      p95: null,
      max: null,
    },
  };
}

type MutableMetrics = SessionLogPerformanceMetrics & {
  latencySamples: number[];
};

function mutableMetrics(): MutableMetrics {
  return { ...emptyMetrics(), latencySamples: [] };
}

function memoryUsedBytes(): number | null {
  if (typeof performance === "undefined") return null;
  const memory = (
    performance as Performance & {
      memory?: { usedJSHeapSize?: unknown };
    }
  ).memory;
  return typeof memory?.usedJSHeapSize === "number"
    ? memory.usedJSHeapSize
    : null;
}

function publicMetrics(metrics: MutableMetrics): SessionLogPerformanceMetrics {
  const samples = [...metrics.latencySamples].sort((a, b) => a - b);
  const percentile = (fraction: number): number | null => {
    if (samples.length === 0) return null;
    const index = Math.min(
      samples.length - 1,
      Math.ceil(fraction * samples.length) - 1
    );
    return samples[index];
  };

  return {
    eventsReceived: metrics.eventsReceived,
    eventsQueued: metrics.eventsQueued,
    eventsVisible: metrics.eventsVisible,
    eventsFlushed: metrics.eventsFlushed,
    storeCommits: metrics.storeCommits,
    rollupRuns: metrics.rollupRuns,
    rollupRecordsProcessed: metrics.rollupRecordsProcessed,
    renderCommits: metrics.renderCommits,
    storeUpdateTimeMs: metrics.storeUpdateTimeMs,
    rollupTimeMs: metrics.rollupTimeMs,
    queueDepth: metrics.queueDepth,
    maxQueueDepth: metrics.maxQueueDepth,
    maxBatchSize: metrics.maxBatchSize,
    retainedRecords: metrics.retainedRecords,
    overflowReconciliations: metrics.overflowReconciliations,
    memoryUsedBytes: memoryUsedBytes(),
    eventToVisibleLatencyMs: {
      count: samples.length,
      p50: percentile(0.5),
      p95: percentile(0.95),
      max: samples.length > 0 ? samples[samples.length - 1] : null,
    },
  };
}

class DefaultSessionLogPerformanceMonitor
  implements SessionLogPerformanceMonitor
{
  private isEnabled = false;
  private readonly projectMetrics = mutableMetrics();
  private readonly executionMetrics = new Map<string, MutableMetrics>();
  private readonly receivedAt = new Map<string, number>();

  get enabled(): boolean {
    return this.isEnabled;
  }

  setEnabled(enabled: boolean): void {
    this.isEnabled = enabled;
    if (!enabled) this.receivedAt.clear();
  }

  reset(): void {
    Object.assign(this.projectMetrics, mutableMetrics());
    this.executionMetrics.clear();
    this.receivedAt.clear();
  }

  snapshot(): SessionLogPerformanceSnapshot {
    const executions: Record<string, SessionLogPerformanceMetrics> = {};
    for (const [executionId, metrics] of this.executionMetrics) {
      executions[executionId] = publicMetrics(metrics);
    }
    return {
      enabled: this.enabled,
      policy: SESSION_LOG_FLUSH_POLICY,
      project: publicMetrics(this.projectMetrics),
      executions,
    };
  }

  recordReceived(
    correlation: SessionLogPerformanceCorrelation,
    receivedAt = nowMs()
  ): void {
    if (!this.enabled) return;
    this.update(correlation, (metrics) => metrics.eventsReceived++);
    this.receivedAt.set(this.correlationId(correlation), receivedAt);
  }

  recordQueued(scope: SessionLogPerformanceScope, queueDepth: number): void {
    if (!this.enabled) return;
    this.update(scope, (metrics) => {
      metrics.eventsQueued++;
      metrics.queueDepth = Math.max(0, queueDepth);
      metrics.maxQueueDepth = Math.max(metrics.maxQueueDepth, metrics.queueDepth);
    });
  }

  recordFlush(
    scope: SessionLogPerformanceScope,
    batchSize: number,
    durationMs = 0
  ): void {
    if (!this.enabled) return;
    this.update(scope, (metrics) => {
      const records = Math.max(0, batchSize);
      metrics.eventsFlushed += records;
      metrics.storeCommits++;
      metrics.maxBatchSize = Math.max(metrics.maxBatchSize, records);
      metrics.storeUpdateTimeMs += nonNegative(durationMs);
      metrics.queueDepth = Math.max(0, metrics.queueDepth - records);
    });
  }

  recordVisible(
    correlation: SessionLogPerformanceCorrelation,
    visibleAt = nowMs()
  ): void {
    if (!this.enabled) return;
    this.update(correlation, (metrics) => metrics.eventsVisible++);
    const id = this.correlationId(correlation);
    const receivedAt = this.receivedAt.get(id);
    if (receivedAt === undefined) return;
    this.receivedAt.delete(id);
    this.recordLatency(correlation, Math.max(0, visibleAt - receivedAt));
  }

  recordRollup(
    scope: SessionLogPerformanceScope,
    recordsProcessed: number,
    durationMs = 0
  ): void {
    if (!this.enabled) return;
    this.update(scope, (metrics) => {
      metrics.rollupRuns++;
      metrics.rollupRecordsProcessed += Math.max(0, recordsProcessed);
      metrics.rollupTimeMs += nonNegative(durationMs);
    });
  }

  recordRender(scope: SessionLogPerformanceScope): void {
    if (!this.enabled) return;
    this.update(scope, (metrics) => metrics.renderCommits++);
  }

  recordRetainedRecords(
    scope: SessionLogPerformanceScope,
    count: number
  ): void {
    if (!this.enabled) return;
    this.update(scope, (metrics) => {
      metrics.retainedRecords = Math.max(0, count);
    });
  }

  recordOverflowReconciliation(scope: SessionLogPerformanceScope): void {
    if (!this.enabled) return;
    this.update(scope, (metrics) => metrics.overflowReconciliations++);
  }

  private correlationId(correlation: SessionLogPerformanceCorrelation): string {
    return `${correlation.projectScope}:${correlation.executionId}:${correlation.recordKey}`;
  }

  private recordLatency(
    correlation: SessionLogPerformanceCorrelation,
    latency: number
  ): void {
    const add = (metrics: MutableMetrics) => {
      metrics.latencySamples.push(latency);
      if (
        metrics.latencySamples.length >
        SESSION_LOG_FLUSH_POLICY.maxLatencySamples
      ) {
        metrics.latencySamples.shift();
      }
    };
    add(this.projectMetrics);
    add(this.getExecutionMetrics(correlation.executionId));
  }

  private getExecutionMetrics(executionId: string): MutableMetrics {
    let metrics = this.executionMetrics.get(executionId);
    if (!metrics) {
      metrics = mutableMetrics();
      this.executionMetrics.set(executionId, metrics);
    }
    return metrics;
  }

  private update(
    scope: SessionLogPerformanceScope | SessionLogPerformanceCorrelation,
    update: (metrics: MutableMetrics) => void
  ): void {
    update(this.projectMetrics);
    if (scope.executionId) update(this.getExecutionMetrics(scope.executionId));
  }
}

export function createSessionLogPerformanceMonitor(): SessionLogPerformanceMonitor {
  return new DefaultSessionLogPerformanceMonitor();
}

/** Shared monitor used by the live listener and opt-in stress diagnostics. */
export const sessionLogPerformance = createSessionLogPerformanceMonitor();

/** Enable/disable the shared monitor without changing event delivery semantics. */
export function configureSessionLogPerformance(enabled: boolean): void {
  sessionLogPerformance.setEnabled(enabled);
}
