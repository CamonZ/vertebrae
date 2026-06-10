/**
 * FlightStrip — single-run timeline minimap.
 *
 * Renders the run's `Thread[]` (via {@link buildFlightProjection}) as four
 * horizontal lanes — Steps · Tools · Turns · Subagents — over a draggable
 * scrub track that mirrors the thread stream's scroll viewport.
 *
 * The Subagents lane (formerly the delegation lane) renders only when the run
 * actually spawned subagents; otherwise it collapses.
 *
 * Interaction:
 *   · the viewport box tracks the linked scroll container (ResizeObserver +
 *     MutationObserver + scroll), and dragging the strip scrubs it;
 *   · clicking a step / pip / subagent selects it and scrolls the linked
 *     stream to the matching `[data-thread-id]` / `[data-evt]` row.
 */

import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

import type { Thread } from "../thread/types";
import { buildFlightProjection, type FlightProjection } from "./timeline";

import "./flightStrip.css";

interface FlightStripProps {
  threads: Thread[];
  /** Scroll container of the thread stream to mirror / scrub. */
  threadScrollRef?: RefObject<HTMLElement | null>;
  /** Currently selected evt / thread id. */
  selectedEvt?: string | null;
  /** Select an evt / thread id (also drives stream scroll-into-view). */
  onSelect?: (id: string) => void;
  /** Override projection (testing). */
  projection?: FlightProjection;
}

const LANE_HEIGHT = 22;
const xPct = (x: number): string => `${(x * 100).toFixed(3)}%`;

export function FlightStrip({
  threads,
  threadScrollRef,
  selectedEvt,
  onSelect,
  projection: projectionOverride,
}: FlightStripProps): ReactNode {
  const [viewport, setViewport] = useState<{
    start: number;
    end: number;
    measured: boolean;
  }>({ start: 0, end: 1, measured: false });
  const viewportRef = useRef(viewport);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const pendingRatioRef = useRef<number | null>(null);
  const draggingRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  // Measured marker positions (fraction of scroll content), keyed by
  // `th:<threadId>` / `ev:<evt>`. Empty until the linked stream is laid out;
  // markers fall back to the time projection's left/width while unmeasured.
  const [markerPos, setMarkerPos] = useState<
    Map<string, { left: number; width: number }>
  >(() => new Map());
  const markerPosRef = useRef(markerPos);

  const projection = useMemo(
    () => projectionOverride ?? buildFlightProjection(threads),
    [projectionOverride, threads]
  );

  // Flat list of measurable markers → DOM selector in the linked stream.
  const markerNodes = useMemo(() => {
    const list: { key: string; selector: string }[] = [];
    const thSel = (id: string): string =>
      `[data-thread-id="${CSS.escape(id)}"]`;
    const evSel = (id: string): string => `[data-evt="${CSS.escape(id)}"]`;
    for (const s of projection.steps)
      list.push({ key: `th:${s.threadId}`, selector: thSel(s.threadId) });
    for (const t of projection.tools)
      list.push({ key: `ev:${t.evt}`, selector: evSel(t.evt) });
    for (const u of projection.turns)
      list.push({ key: `ev:${u.evt}`, selector: evSel(u.evt) });
    for (const s of projection.spawns)
      list.push({ key: `th:${s.threadId}`, selector: thSel(s.threadId) });
    return list;
  }, [projection]);

  const laneCount = projection.hasSpawns ? 4 : 3;
  const lanesHeight = laneCount * LANE_HEIGHT;

  // ── tracking: mirror the linked scroll container ──
  // The strip is a minimap of the *scroll content*, not of wall-clock time, so
  // both the viewport box and every marker are positioned by their pixel offset
  // within the stream. This keeps them on a single axis, so the box always sits
  // over the events it is actually scrolled past.
  useEffect(() => {
    let attached: HTMLElement | null = null;
    let rafId: number | null = null;
    let resizeObs: ResizeObserver | null = null;
    let mutationObs: MutationObserver | null = null;
    let cancelled = false;

    const measureViewport = (el: HTMLElement): void => {
      const max = el.scrollHeight - el.clientHeight;
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

    // Position of a node as a fraction of the scroll content (top edge +
    // height). Scroll-independent — only changes on layout/mutation.
    const nodeFraction = (
      el: HTMLElement,
      node: HTMLElement
    ): { left: number; width: number } | null => {
      const sh = el.scrollHeight;
      if (sh <= 0) return null;
      const cRect = el.getBoundingClientRect();
      const nRect = node.getBoundingClientRect();
      const top = nRect.top - cRect.top + el.scrollTop;
      if (!Number.isFinite(top)) return null;
      return {
        left: Math.max(0, Math.min(1, top / sh)),
        width: Math.max(0, Math.min(1, nRect.height / sh)),
      };
    };

    const measureMarkers = (el: HTMLElement): void => {
      const next = new Map<string, { left: number; width: number }>();
      for (const { key, selector } of markerNodes) {
        if (next.has(key)) continue;
        const node = el.querySelector<HTMLElement>(selector);
        if (!node) continue;
        const frac = nodeFraction(el, node);
        if (frac) next.set(key, frac);
      }
      const prev = markerPosRef.current;
      let same = next.size === prev.size;
      if (same) {
        for (const [k, v] of next) {
          const w = prev.get(k);
          if (
            !w ||
            Math.abs(w.left - v.left) > 1e-4 ||
            Math.abs(w.width - v.width) > 1e-4
          ) {
            same = false;
            break;
          }
        }
      }
      if (same) return;
      markerPosRef.current = next;
      setMarkerPos(next);
    };

    const measureAll = (el: HTMLElement): void => {
      measureViewport(el);
      measureMarkers(el);
    };

    const onScroll = (): void => {
      if (attached) measureViewport(attached);
    };

    const attach = (el: HTMLElement): void => {
      attached = el;
      measureAll(el);
      el.addEventListener("scroll", onScroll, { passive: true });
      resizeObs = new ResizeObserver(() => measureAll(el));
      resizeObs.observe(el);
      mutationObs = new MutationObserver(() => measureAll(el));
      mutationObs.observe(el, { childList: true, subtree: true });
    };

    const tryAttach = (): void => {
      if (cancelled) return;
      const el = threadScrollRef?.current ?? null;
      if (el) {
        attach(el);
        return;
      }
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
  }, [threadScrollRef, markerNodes]);

  // ── scrub: rAF-coalesced scroll writes ──
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
    if (rect.width <= 0) return 0;
    return Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
  }, []);

  // ── selection → scroll the stream to the target row ──
  const scrollToTarget = useCallback(
    (id: string, fallbackThreadId?: string, fallbackX?: number) => {
      onSelect?.(id);
      const el = threadScrollRef?.current ?? null;
      if (!el) return;
      const target =
        el.querySelector<HTMLElement>(`[data-evt="${CSS.escape(id)}"]`) ??
        el.querySelector<HTMLElement>(`[data-thread-id="${CSS.escape(id)}"]`) ??
        (fallbackThreadId
          ? el.querySelector<HTMLElement>(
              `[data-thread-id="${CSS.escape(fallbackThreadId)}"]`
            )
          : null);
      if (target) {
        target.scrollIntoView({ behavior: "auto", block: "start" });
        return;
      }
      if (fallbackX !== undefined) scheduleScrub(fallbackX);
    },
    [onSelect, threadScrollRef, scheduleScrub]
  );

  const handlePointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      draggingRef.current = true;
      setDragging(true);
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
      setDragging(false);
      try {
        e.currentTarget.releasePointerCapture(e.pointerId);
      } catch {
        // capture may already be released
      }
    },
    []
  );

  const toolLaneTop = LANE_HEIGHT;
  const turnLaneTop = LANE_HEIGHT * 2;
  const spawnLaneTop = LANE_HEIGHT * 3;

  return (
    <div
      data-testid="flight-strip"
      className={`flight-strip${dragging ? " dragging" : ""}`}
    >
      <div
        ref={containerRef}
        role="slider"
        aria-label="Run timeline"
        aria-valuemin={0}
        aria-valuemax={1}
        aria-valuenow={viewport.start}
        tabIndex={0}
        data-testid="flight-strip-canvas"
        className="fs-lanes touch-none"
        style={{ height: lanesHeight }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerUp}
      >
        {/* Lane backgrounds + labels */}
        <div className="lane" style={{ top: 0 }}>
          <span className="lane-label">Steps</span>
        </div>
        <div className="lane" style={{ top: toolLaneTop }}>
          <span className="lane-label">Tools</span>
        </div>
        <div
          className={`lane${projection.hasSpawns ? "" : " last"}`}
          style={{ top: turnLaneTop }}
        >
          <span className="lane-label">Turns</span>
        </div>
        {projection.hasSpawns && (
          <div className="lane last" style={{ top: spawnLaneTop }}>
            <span className="lane-label">Subagents</span>
          </div>
        )}

        {/* Steps lane */}
        {projection.steps.map((s) => {
          const pos = markerPos.get(`th:${s.threadId}`);
          const left = pos?.left ?? s.left;
          const width = pos?.width ?? s.width;
          return (
            <button
              type="button"
              key={`step-${s.threadId}`}
              data-testid="flight-strip-step"
              data-thread-id={s.threadId}
              data-kind={s.kind}
              data-live={s.live ? "1" : "0"}
              title={s.label}
              onClick={(e) => {
                e.stopPropagation();
                scrollToTarget(s.threadId, s.threadId, left);
              }}
              className={`mk kind-${s.kind}${s.live ? " live" : ""}${
                selectedEvt === s.threadId ? " sel" : ""
              }`}
              style={{
                left: xPct(left),
                width: xPct(Math.max(0.004, width)),
                top: 4,
              }}
            />
          );
        })}

        {/* Tools lane */}
        {projection.tools.map((t) => {
          const left = markerPos.get(`ev:${t.evt}`)?.left ?? t.left;
          return (
            <button
              type="button"
              key={`tool-${t.evt}`}
              data-testid="flight-strip-tool"
              data-evt={t.evt}
              data-error={t.error ? "1" : "0"}
              onClick={(e) => {
                e.stopPropagation();
                scrollToTarget(t.evt, t.threadId, left);
              }}
              className={`pip ${t.error ? "error" : "tool"}${
                selectedEvt === t.evt ? " sel" : ""
              }`}
              style={{ left: xPct(left), top: toolLaneTop + LANE_HEIGHT / 2 }}
            />
          );
        })}

        {/* Turns lane */}
        {projection.turns.map((u) => {
          const left = markerPos.get(`ev:${u.evt}`)?.left ?? u.left;
          return (
            <button
              type="button"
              key={`turn-${u.evt}`}
              data-testid="flight-strip-turn"
              data-evt={u.evt}
              onClick={(e) => {
                e.stopPropagation();
                scrollToTarget(u.evt, u.threadId, left);
              }}
              className={`pip agent${selectedEvt === u.evt ? " sel" : ""}`}
              style={{ left: xPct(left), top: turnLaneTop + LANE_HEIGHT / 2 }}
            />
          );
        })}

        {/* Subagents lane (+ edges) */}
        {projection.hasSpawns && (
          <>
            {projection.spawnEdges.map((edge, i) => {
              const x = markerPos.get(`th:${edge.childThreadId}`)?.left ?? edge.x;
              return (
                <div
                  key={`edge-${edge.childThreadId}-${i}`}
                  data-testid="flight-strip-spawn-edge"
                  className="spawn-edge"
                  style={{
                    left: xPct(x),
                    top: 4,
                    height: spawnLaneTop,
                  }}
                />
              );
            })}
            {projection.spawns.map((s) => {
              const pos = markerPos.get(`th:${s.threadId}`);
              const left = pos?.left ?? s.left;
              const width = pos?.width ?? s.width;
              return (
                <button
                  type="button"
                  key={`spawn-${s.threadId}`}
                  data-testid="flight-strip-spawn"
                  data-thread-id={s.threadId}
                  data-kind={s.kind}
                  title={s.label}
                  onClick={(e) => {
                    e.stopPropagation();
                    scrollToTarget(s.threadId, s.threadId, left);
                  }}
                  className={`mk kind-${s.kind}${
                    selectedEvt === s.threadId ? " sel" : ""
                  }`}
                  style={{
                    left: xPct(left),
                    width: xPct(Math.max(0.004, width)),
                    top: spawnLaneTop + 4,
                  }}
                />
              );
            })}
          </>
        )}

        {/* Playhead — marks where the bottom of the visible stream sits. */}
        <div
          data-testid="flight-strip-viewport"
          aria-hidden="true"
          className="vp-line"
          style={{
            left: xPct(viewport.end),
            height: lanesHeight,
            visibility: viewport.measured ? "visible" : "hidden",
          }}
          data-end={viewport.end.toFixed(4)}
          data-measured={viewport.measured ? "true" : "false"}
        />
      </div>
    </div>
  );
}
