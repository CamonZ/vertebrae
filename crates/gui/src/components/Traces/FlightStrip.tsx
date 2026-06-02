import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";
import type { SessionLog, StepExecution, Task } from "../../bindings";
import { EventGlyph, resolveGlyph } from "./EventGlyph";
import { levelTintClass } from "./levelColors";
import {
  buildTimelineProjection,
  buildTimelineProjectionFromProjection,
  type ThresholdMarker,
  type TimelineMarker,
  type TimelineProjection,
} from "./timeline";
import type { TaskRunTraceProjection } from "./taskRunTrace";
import {
  summarizeExecutions,
  summarizeProjection,
  traceDebug,
} from "./traceDebug";

interface FlightStripProps {
  rootTaskId: string;
  executions: readonly StepExecution[];
  tasks: readonly Task[];
  runProjection?: TaskRunTraceProjection | null;
  logsByExecutionId: Readonly<Record<string, SessionLog[]>>;
  threadScrollRef?: RefObject<HTMLElement | null>;
  /** Override projection (testing). */
  projection?: TimelineProjection;
}

const LANE_HEIGHT = 14;
const THRESHOLD_CALLOUT_HEIGHT = 14;
const THRESHOLD_LANE_HEIGHT = 22;
const TOOL_LANE_HEIGHT = 16;
const PADDING_X = 8;
const LANE_LABEL_WIDTH = 76;
const CALLOUT_MIN_GAP_PX = 70;
const LANE_BAND_CLASS =
  "border-b border-[var(--color-line)]/40 bg-[linear-gradient(90deg,var(--color-line)_1px,transparent_1px)] bg-[length:12.5%_100%]";
const MARKER_BUTTON_CLASS =
  "rounded-full border border-[var(--color-line)] bg-[var(--color-bg)] shadow-1 hover:border-[var(--color-line-strong)] hover:bg-[var(--color-bg-3)]";

const THRESHOLD_TITLES: Record<ThresholdMarker["kind"], string | null> = {
  approval: "APPROVAL",
  rejection: "REJECTION",
  model_fallback: "MODEL FALLBACK",
  transition: "TRANSITION",
  retry: "RETRY",
  execution_start: null,
  execution_end: null,
};

export function computeCalloutVisibility(
  thresholds: readonly ThresholdMarker[],
  canvasWidthPx: number,
  minGapPx: number = CALLOUT_MIN_GAP_PX
): boolean[] {
  const visible = thresholds.map((m) => THRESHOLD_TITLES[m.kind] !== null);
  if (canvasWidthPx <= 0) return visible;
  const order = thresholds
    .map((_, i) => i)
    .sort((a, b) => thresholds[a].x - thresholds[b].x);
  let lastShownPx: number | null = null;
  for (const i of order) {
    if (!visible[i]) continue;
    const px = thresholds[i].x * canvasWidthPx;
    if (lastShownPx !== null && px - lastShownPx < minGapPx) {
      visible[i] = false;
      continue;
    }
    lastShownPx = px;
  }
  return visible;
}

const xPct = (x: number): string => `${(x * 100).toFixed(3)}%`;

export function FlightStrip({
  rootTaskId,
  executions,
  tasks,
  runProjection,
  logsByExecutionId,
  threadScrollRef,
  projection: projectionOverride,
}: FlightStripProps): ReactNode {
  const [thresholdsOnly, setThresholdsOnly] = useState(false);
  const [canvasWidth, setCanvasWidth] = useState(0);
  const [viewport, setViewport] = useState<{
    start: number;
    end: number;
    measured: boolean;
  }>({ start: 0, end: 1, measured: false });
  const viewportRef = useRef(viewport);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRatioRef = useRef<number | null>(null);

  const projection = useMemo(() => {
    if (projectionOverride) return projectionOverride;
    if (runProjection?.hasRuns) {
      return buildTimelineProjectionFromProjection(
        runProjection,
        logsByExecutionId
      );
    }
    return buildTimelineProjection(
      rootTaskId,
      executions,
      tasks,
      logsByExecutionId
    );
  }, [
    projectionOverride,
    rootTaskId,
    executions,
    tasks,
    runProjection,
    logsByExecutionId,
  ]);

  useEffect(() => {
    traceDebug("render flight-strip", {
      rootTaskId,
      executions: summarizeExecutions(executions),
      projection: summarizeProjection(runProjection ?? null),
      timelineRows: projection.mainRows.map((row) => ({
        rowKey: row.rowKey,
        taskRunId: row.taskRunId,
        taskId: row.taskId,
      })),
      thresholdExecutionIds: projection.thresholds.map(
        (marker) => marker.executionId
      ),
      mainExecutionIds: projection.main.map((marker) => marker.executionId),
    });
  }, [executions, projection, rootTaskId, runProjection]);

  useEffect(() => {
    let attached: HTMLElement | null = null;
    let rafId: number | null = null;
    let resizeObs: ResizeObserver | null = null;
    let mutationObs: MutationObserver | null = null;
    let cancelled = false;

    const measure = (el: HTMLElement): void => {
      const max = el.scrollHeight - el.clientHeight;
      // Not yet measurable (layout hasn't happened or content hasn't loaded).
      // Leave the previous viewport state alone and wait for the next tick —
      // ResizeObserver / MutationObserver / scroll will retry.
      if (max <= 0) return;
      const start = el.scrollTop / max;
      const visible = el.clientHeight / el.scrollHeight;
      const clampedStart = Math.max(0, Math.min(1, start * (1 - visible)));
      const next = {
        start: clampedStart,
        end: Math.max(0, Math.min(1, clampedStart + visible)),
        measured: true,
      };
      const prev = viewportRef.current;
      if (
        prev.measured &&
        Math.abs(next.start - prev.start) < 1e-4 &&
        Math.abs(next.end - prev.end) < 1e-4
      ) {
        return;
      }
      viewportRef.current = next;
      setViewport(next);
    };

    const onScroll = (): void => {
      if (attached) measure(attached);
    };

    const attach = (el: HTMLElement): void => {
      attached = el;
      measure(el);
      el.addEventListener("scroll", onScroll, { passive: true });
      // Container resize → re-measure (e.g. window resize, splitter drag).
      resizeObs = new ResizeObserver(() => measure(el));
      resizeObs.observe(el);
      // Subtree mutations → re-measure. Async content rendering changes
      // scrollHeight but doesn't fire ResizeObserver on the container itself.
      mutationObs = new MutationObserver(() => measure(el));
      mutationObs.observe(el, { childList: true, subtree: true });
    };

    const tryAttach = (): void => {
      if (cancelled) return;
      const el = threadScrollRef?.current ?? null;
      if (el) {
        attach(el);
        return;
      }
      // Ref hasn't been wired yet — re-check on next frame. The effect's
      // dependency only retriggers on the ref object identity, not on
      // .current mutation, so we have to poll until it lands.
      rafId = window.requestAnimationFrame(tryAttach);
    };

    tryAttach();

    return () => {
      cancelled = true;
      if (rafId !== null) window.cancelAnimationFrame(rafId);
      if (attached) attached.removeEventListener("scroll", onScroll);
      resizeObs?.disconnect();
      mutationObs?.disconnect();
    };
  }, [threadScrollRef]);

  // rAF-coalesce scrub writes so drag stays interactive at 60fps even with
  // thousands of pointermove events.
  const flushScrub = useCallback(() => {
    rafRef.current = null;
    const ratio = pendingRatioRef.current;
    pendingRatioRef.current = null;
    if (ratio === null) return;
    const el = threadScrollRef?.current ?? null;
    if (!el) return;
    const max = el.scrollHeight - el.clientHeight;
    if (max <= 0) return;
    el.scrollTop = ratio * max;
  }, [threadScrollRef]);

  const scheduleScrub = useCallback(
    (ratio: number) => {
      pendingRatioRef.current = Math.max(0, Math.min(1, ratio));
      if (rafRef.current !== null) return;
      const raf =
        typeof window !== "undefined" && window.requestAnimationFrame
          ? window.requestAnimationFrame
          : (cb: FrameRequestCallback) =>
              setTimeout(() => cb(0), 16) as unknown as number;
      // Sentinel before invoking: a synchronous-rAF (test env) will reset
      // rafRef to null during flush, and we must not overwrite that with the
      // returned id afterwards.
      rafRef.current = -1;
      const id = raf(flushScrub);
      if (rafRef.current !== null) rafRef.current = id;
    },
    [flushScrub]
  );

  useLayoutEffect(() => {
    return () => {
      if (rafRef.current !== null && typeof window !== "undefined") {
        window.cancelAnimationFrame?.(rafRef.current);
      }
    };
  }, []);

  const xToRatio = useCallback((clientX: number): number => {
    const el = containerRef.current;
    if (!el) return 0;
    const rect = el.getBoundingClientRect();
    const inner = rect.width;
    if (inner <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / inner));
  }, []);

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = (): void => {
      const w = el.getBoundingClientRect().width;
      setCanvasWidth((prev) => (Math.abs(prev - w) < 0.5 ? prev : w));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  const handleMarkerClick = useCallback(
    (marker: TimelineMarker) => {
      const el = threadScrollRef?.current ?? null;
      if (!el) return;
      const target = el.querySelector<HTMLElement>(
        `[data-execution-id="${marker.executionId}"]`
      );
      if (target) {
        target.scrollIntoView({ behavior: "auto", block: "start" });
        return;
      }
      scheduleScrub(marker.x);
    },
    [threadScrollRef, scheduleScrub]
  );

  const draggingRef = useRef(false);
  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      e.currentTarget.setPointerCapture(e.pointerId);
      scheduleScrub(xToRatio(e.clientX));
    },
    [scheduleScrub, xToRatio]
  );
  const handlePointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!draggingRef.current) return;
      scheduleScrub(xToRatio(e.clientX));
    },
    [scheduleScrub, xToRatio]
  );
  const handlePointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      draggingRef.current = false;
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // capture may already be released
      }
    },
    []
  );

  const mainLaneHeight = projection.mainRows.length * LANE_HEIGHT;
  const thresholdBlockHeight = THRESHOLD_CALLOUT_HEIGHT + THRESHOLD_LANE_HEIGHT;
  const totalHeight = thresholdsOnly
    ? thresholdBlockHeight + 8
    : thresholdBlockHeight +
      TOOL_LANE_HEIGHT +
      Math.max(LANE_HEIGHT, mainLaneHeight) +
      16;

  const calloutVisible = useMemo(
    () => computeCalloutVisibility(projection.thresholds, canvasWidth),
    [projection.thresholds, canvasWidth]
  );

  const toolLaneTop = thresholdBlockHeight;
  const mainLaneTop = thresholdBlockHeight + TOOL_LANE_HEIGHT;

  return (
    <div
      data-testid="flight-strip"
      data-variant="hearth-v2"
      className="relative w-full select-none rounded-[var(--radius-md)] border border-[var(--color-line)] bg-[var(--color-bg-1)] shadow-1"
      style={{ paddingLeft: PADDING_X, paddingRight: PADDING_X }}
    >
      <div className="flex items-center justify-between gap-2 border-b border-[var(--color-line)] px-2 py-1.5">
        <div className="flex items-center gap-2">
          <span className="font-mono text-2xs uppercase tracking-wider text-[var(--color-fg-mute)]">
            Flight strip
          </span>
          <span
            data-testid="flight-strip-summary"
            className="rounded-full border border-[var(--color-line)] bg-[var(--color-bg-2)] px-2 py-0.5 font-mono text-[9px] text-[var(--color-fg-mute)]"
          >
            {projection.thresholds.length} steps · {projection.tools.length}{" "}
            tools
          </span>
        </div>
        <label
          data-testid="flight-strip-thresholds-only-label"
          className="flex cursor-pointer items-center gap-1 text-2xs text-[var(--color-fg-soft)]"
        >
          <input
            data-testid="flight-strip-thresholds-only"
            type="checkbox"
            checked={thresholdsOnly}
            onChange={(e) => setThresholdsOnly(e.target.checked)}
            className="h-3 w-3"
          />
          Thresholds only
        </label>
      </div>

      <div className="relative flex w-full" style={{ height: totalHeight }}>
        <LaneGutter
          thresholdsOnly={thresholdsOnly}
          thresholdBlockHeight={thresholdBlockHeight}
          toolLaneTop={toolLaneTop}
          mainLaneTop={mainLaneTop}
          mainLaneHeight={Math.max(LANE_HEIGHT, mainLaneHeight)}
          hasDelegations={projection.delegations.length > 0}
        />
        <div
          ref={containerRef}
          data-testid="flight-strip-canvas"
          role="slider"
          aria-label="Subtree timeline"
          aria-valuemin={0}
          aria-valuemax={1}
          aria-valuenow={viewport.start}
          tabIndex={0}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={handlePointerUp}
          className="relative flex-1 cursor-pointer touch-none active:cursor-grabbing"
        >
          <ThresholdLane
            thresholds={projection.thresholds}
            calloutVisible={calloutVisible}
            onMarkerClick={handleMarkerClick}
            calloutHeight={THRESHOLD_CALLOUT_HEIGHT}
            laneHeight={THRESHOLD_LANE_HEIGHT}
            showBand={!thresholdsOnly}
          />

          {!thresholdsOnly && (
            <>
              <Lane
                testId="flight-strip-lane-tool"
                top={toolLaneTop}
                height={TOOL_LANE_HEIGHT}
                className={LANE_BAND_CLASS}
              >
                {projection.tools.map((m, i) => (
                  <button
                    type="button"
                    key={`tl-${i}`}
                    data-testid="flight-strip-marker-tool"
                    data-kind={m.kind}
                    data-execution-id={m.executionId}
                    title={`${m.kind === "tool_use" ? "⊳" : "⊲"} ${m.toolName}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleMarkerClick(m);
                    }}
                    className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-0.5 leading-none ${MARKER_BUTTON_CLASS}`}
                    style={{ left: xPct(m.x) }}
                  >
                    <EventGlyph event={m} size={12} />
                  </button>
                ))}
              </Lane>

              <div
                data-testid="flight-strip-lane-main"
                className={`absolute left-0 right-0 ${LANE_BAND_CLASS}`}
                style={{
                  top: mainLaneTop,
                  height: Math.max(LANE_HEIGHT, mainLaneHeight),
                }}
              >
                {projection.mainRows.map((row) => (
                  <div
                    key={row.rowKey}
                    data-testid="flight-strip-main-row"
                    data-task-id={row.taskId}
                    data-task-run-id={row.taskRunId ?? undefined}
                    data-row-index={row.index}
                    className="absolute left-0 right-0 border-t border-[var(--color-line)]/40"
                    style={{
                      top: row.index * LANE_HEIGHT,
                      height: LANE_HEIGHT,
                    }}
                  >
                    {projection.mainByRow[row.index]?.map((m, i) => (
                      <button
                        type="button"
                        key={`mn-${row.index}-${i}`}
                        data-testid="flight-strip-marker-main"
                        data-execution-id={m.executionId}
                        data-task-id={m.taskId}
                        onClick={(e) => {
                          e.stopPropagation();
                          handleMarkerClick(m);
                        }}
                        className={`absolute top-1/2 -translate-x-1/2 -translate-y-1/2 p-0.5 leading-none ${MARKER_BUTTON_CLASS}`}
                        style={{ left: xPct(m.x) }}
                      >
                        <EventGlyph
                          event={m}
                          size={10}
                          tintClassName={levelTintClass(row.level)}
                        />
                      </button>
                    ))}
                  </div>
                ))}

                <svg
                  data-testid="flight-strip-delegation-svg"
                  className="pointer-events-none absolute inset-0 h-full w-full overflow-visible"
                  aria-hidden="true"
                >
                  {projection.delegations.map((d, i) => {
                    const y1 = d.parentRowIndex * LANE_HEIGHT + LANE_HEIGHT / 2;
                    const y2 = d.childRowIndex * LANE_HEIGHT + LANE_HEIGHT / 2;
                    return (
                      <line
                        key={`dg-${i}`}
                        data-testid="flight-strip-delegation-edge"
                        data-parent-task-id={d.parentTaskId}
                        data-child-task-id={d.childTaskId}
                        data-child-level={d.childLevel ?? ""}
                        x1={xPct(d.x)}
                        x2={xPct(d.x)}
                        y1={y1}
                        y2={y2}
                        stroke="currentColor"
                        strokeOpacity={0.7}
                        strokeWidth={1.5}
                        strokeDasharray="2 2"
                        className={levelTintClass(d.childLevel)}
                      />
                    );
                  })}
                </svg>
              </div>
            </>
          )}

          <div
            data-testid="flight-strip-viewport"
            aria-hidden="true"
            className="pointer-events-none absolute top-0 bottom-0 border border-[var(--color-accent)]/70 bg-[var(--color-accent)]/10"
            style={
              {
                left: xPct(viewport.start),
                width: xPct(Math.max(0.005, viewport.end - viewport.start)),
                visibility: viewport.measured ? "visible" : "hidden",
              } as CSSProperties
            }
            data-start={viewport.start.toFixed(4)}
            data-end={viewport.end.toFixed(4)}
            data-measured={viewport.measured ? "true" : "false"}
          />
        </div>
      </div>
    </div>
  );
}

function Lane({
  testId,
  top,
  height,
  children,
  className = "",
}: {
  testId: string;
  top: number;
  height: number;
  children?: ReactNode;
  className?: string;
}): ReactNode {
  return (
    <div
      data-testid={testId}
      className={`absolute left-0 right-0 ${className}`}
      style={{ top, height }}
    >
      {children}
    </div>
  );
}

function GutterLabel({
  testId,
  label,
  top,
  height,
}: {
  testId: string;
  label: string;
  top: number;
  height: number;
}): ReactNode {
  return (
    <div
      data-testid={testId}
      className="absolute left-0 right-1 flex items-center justify-end pr-2 font-mono text-[9px] uppercase tracking-wider text-[var(--color-fg-mute)]"
      style={{ top, height }}
    >
      {label}
    </div>
  );
}

function LaneGutter({
  thresholdsOnly,
  thresholdBlockHeight,
  toolLaneTop,
  mainLaneTop,
  mainLaneHeight,
  hasDelegations,
}: {
  thresholdsOnly: boolean;
  thresholdBlockHeight: number;
  toolLaneTop: number;
  mainLaneTop: number;
  mainLaneHeight: number;
  hasDelegations: boolean;
}): ReactNode {
  return (
    <div
      data-testid="flight-strip-gutter"
      className="relative flex-shrink-0 border-r border-[var(--color-line)]/60 bg-[var(--color-bg-2)]/35"
      style={{ width: LANE_LABEL_WIDTH }}
    >
      <GutterLabel
        testId="flight-strip-gutter-label-threshold"
        label="THRESHOLD"
        top={0}
        height={thresholdBlockHeight}
      />
      {!thresholdsOnly && (
        <>
          <GutterLabel
            testId="flight-strip-gutter-label-tool"
            label="TOOL"
            top={toolLaneTop}
            height={TOOL_LANE_HEIGHT}
          />
          <GutterLabel
            testId="flight-strip-gutter-label-main"
            label="MAIN"
            top={mainLaneTop}
            height={mainLaneHeight}
          />
          {hasDelegations && (
            <GutterLabel
              testId="flight-strip-gutter-label-delegation"
              label="DELEGATION"
              top={mainLaneTop + mainLaneHeight - 12}
              height={12}
            />
          )}
        </>
      )}
    </div>
  );
}

function ThresholdLane({
  thresholds,
  calloutVisible,
  onMarkerClick,
  calloutHeight,
  laneHeight,
  showBand,
}: {
  thresholds: readonly ThresholdMarker[];
  calloutVisible: readonly boolean[];
  onMarkerClick: (m: TimelineMarker) => void;
  calloutHeight: number;
  laneHeight: number;
  showBand: boolean;
}): ReactNode {
  return (
    <div
      data-testid="flight-strip-lane-threshold"
      className={`absolute left-0 right-0 ${showBand ? LANE_BAND_CLASS : ""}`}
      style={{ top: 0, height: calloutHeight + laneHeight }}
    >
      {thresholds.map((m, i) => {
        const isError = resolveGlyph(m).variant === "error";
        const title = THRESHOLD_TITLES[m.kind];
        const showTitle = title !== null && calloutVisible[i];
        return (
          <div
            key={`th-wrap-${i}`}
            className="absolute -translate-x-1/2"
            style={{ left: xPct(m.x), top: 0 }}
          >
            {title !== null && (
              <span
                data-testid="flight-strip-threshold-callout"
                data-kind={m.kind}
                data-execution-id={m.executionId}
                data-visible={showTitle ? "true" : "false"}
                aria-hidden={showTitle ? undefined : "true"}
                className={`pointer-events-none absolute left-1/2 top-0 -translate-x-1/2 whitespace-nowrap font-mono text-[8px] uppercase tracking-wider ${
                  isError
                    ? "text-[var(--color-err)]"
                    : "text-[var(--color-fg-soft)]"
                }`}
                style={{
                  height: calloutHeight,
                  visibility: showTitle ? "visible" : "hidden",
                }}
              >
                {title}
              </span>
            )}
            <button
              type="button"
              data-testid="flight-strip-marker-threshold"
              data-kind={m.kind}
              data-execution-id={m.executionId}
              data-task-id={m.taskId}
              title={m.label}
              onClick={(e) => {
                e.stopPropagation();
                onMarkerClick(m);
              }}
              className={`absolute left-1/2 -translate-x-1/2 flex items-center justify-center ${MARKER_BUTTON_CLASS}`}
              style={{ top: calloutHeight, width: 16, height: laneHeight }}
            >
              <EventGlyph event={m} size={12} />
            </button>
          </div>
        );
      })}
    </div>
  );
}
