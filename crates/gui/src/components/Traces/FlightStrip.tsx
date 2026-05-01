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
import {
  buildTimelineProjection,
  type TimelineMarker,
  type TimelineProjection,
} from "./timeline";

interface FlightStripProps {
  rootTaskId: string;
  executions: readonly StepExecution[];
  tasks: readonly Task[];
  logsByExecutionId: Readonly<Record<string, SessionLog[]>>;
  threadScrollRef?: RefObject<HTMLElement | null>;
  /** Override projection (testing). */
  projection?: TimelineProjection;
}

const LANE_HEIGHT = 14;
const THRESHOLD_LANE_HEIGHT = 18;
const TOOL_LANE_HEIGHT = 16;
const PADDING_X = 8;

const xPct = (x: number): string => `${(x * 100).toFixed(3)}%`;

export function FlightStrip({
  rootTaskId,
  executions,
  tasks,
  logsByExecutionId,
  threadScrollRef,
  projection: projectionOverride,
}: FlightStripProps): ReactNode {
  const [thresholdsOnly, setThresholdsOnly] = useState(false);
  const [viewport, setViewport] = useState<{
    start: number;
    end: number;
    measured: boolean;
  }>({ start: 0, end: 1, measured: false });
  const viewportRef = useRef(viewport);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRatioRef = useRef<number | null>(null);

  const projection = useMemo(
    () =>
      projectionOverride ??
      buildTimelineProjection(
        rootTaskId,
        executions,
        tasks,
        logsByExecutionId
      ),
    [projectionOverride, rootTaskId, executions, tasks, logsByExecutionId]
  );

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
    const inner = rect.width - PADDING_X * 2;
    if (inner <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left - PADDING_X) / inner));
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
  const totalHeight = thresholdsOnly
    ? THRESHOLD_LANE_HEIGHT + 8
    : THRESHOLD_LANE_HEIGHT +
      TOOL_LANE_HEIGHT +
      Math.max(LANE_HEIGHT, mainLaneHeight) +
      16;

  return (
    <div
      data-testid="flight-strip"
      className="relative w-full select-none border-b border-border bg-bg-secondary"
      style={{ paddingLeft: PADDING_X, paddingRight: PADDING_X }}
    >
      <div className="flex items-center justify-between gap-2 px-1 pt-1">
        <span className="font-mono text-[10px] uppercase tracking-wider text-text-muted">
          Flight strip
        </span>
        <label
          data-testid="flight-strip-thresholds-only-label"
          className="flex cursor-pointer items-center gap-1 text-[10px] text-text-secondary"
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
        className="relative w-full cursor-pointer touch-none active:cursor-grabbing"
        style={{ height: totalHeight }}
      >
        <Lane
          testId="flight-strip-lane-threshold"
          label="THRESHOLD"
          top={0}
          height={THRESHOLD_LANE_HEIGHT}
        >
          {projection.thresholds.map((m, i) => (
            <button
              type="button"
              key={`th-${i}`}
              data-testid="flight-strip-marker-threshold"
              data-kind={m.kind}
              data-execution-id={m.executionId}
              data-task-id={m.taskId}
              title={m.label}
              onClick={(e) => {
                e.stopPropagation();
                handleMarkerClick(m);
              }}
              className="absolute top-1/2 h-3 w-[6px] -translate-x-1/2 -translate-y-1/2 rounded-sm border border-warning/60 bg-warning/70 hover:bg-warning"
              style={{ left: xPct(m.x) }}
            />
          ))}
        </Lane>

        {!thresholdsOnly && (
          <>
            <Lane
              testId="flight-strip-lane-tool"
              label="TOOL"
              top={THRESHOLD_LANE_HEIGHT}
              height={TOOL_LANE_HEIGHT}
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
                  className={`absolute top-1/2 h-2 w-2 -translate-x-1/2 -translate-y-1/2 rounded-full ${
                    m.kind === "tool_use"
                      ? "bg-accent-primary"
                      : m.isError
                        ? "bg-error"
                        : "bg-accent-secondary"
                  }`}
                  style={{ left: xPct(m.x) }}
                />
              ))}
            </Lane>

            <div
              data-testid="flight-strip-lane-main"
              className="absolute left-0 right-0"
              style={{
                top: THRESHOLD_LANE_HEIGHT + TOOL_LANE_HEIGHT,
                height: Math.max(LANE_HEIGHT, mainLaneHeight),
              }}
            >
              {projection.mainRows.map((row) => (
                <div
                  key={row.taskId}
                  data-testid="flight-strip-main-row"
                  data-task-id={row.taskId}
                  data-row-index={row.index}
                  className="absolute left-0 right-0 border-t border-border/40"
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
                      className="absolute top-1/2 h-1.5 w-[3px] -translate-x-1/2 -translate-y-1/2 rounded-sm bg-text-secondary/70 hover:bg-text-primary"
                      style={{ left: xPct(m.x) }}
                    />
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
                      x1={xPct(d.x)}
                      x2={xPct(d.x)}
                      y1={y1}
                      y2={y2}
                      stroke="currentColor"
                      strokeOpacity={0.5}
                      strokeWidth={1}
                      strokeDasharray="2 2"
                      className="text-accent-primary"
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
          className="pointer-events-none absolute top-0 bottom-0 border border-accent-primary/70 bg-accent-primary/10"
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
  );
}

function Lane({
  testId,
  label,
  top,
  height,
  children,
}: {
  testId: string;
  label: string;
  top: number;
  height: number;
  children?: ReactNode;
}): ReactNode {
  return (
    <div
      data-testid={testId}
      className="absolute left-0 right-0"
      style={{ top, height }}
    >
      <span
        aria-hidden="true"
        className="pointer-events-none absolute left-1 top-0 z-10 font-mono text-[8px] uppercase tracking-wider text-text-muted/70"
      >
        {label}
      </span>
      {children}
    </div>
  );
}
