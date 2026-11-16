/**
 * TaskRun motion on the Atlas Graph: when a TaskRun moves from one step to
 * another, one card travels the rail that carries that move at the current
 * level (a factory route, a workflow handoff or a step transition) and is
 * gone when it arrives. Neutral rails, colour only on what moves.
 *
 * Nothing animates while nothing happens: animation frames run only while a
 * card is travelling. Travel is capped, skipped while the Graph is off-screen
 * or the document is hidden, and under reduced motion the card appears at
 * its destination instead of travelling.
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import type { PipelineSummary } from "../../../bindings";
import type { DiagramTimeline } from "../../MachineDiagram/flow/compile";
import { useReducedMotion } from "../../MachineDiagram/useReducedMotion";
import type { AtlasGraphLevel } from "./atlasLevels";
import type { AtlasMachineFlow } from "./buildMachineFlow";
import {
  ARRIVE_MS,
  MAX_TRAVELLING,
  TRAVEL_MS,
  along,
  railForMove,
  taskRunMoves,
  type MoveSource,
} from "./taskRunMotionModel";

interface Travel {
  readonly key: string;
  readonly rail: string;
  readonly start: number;
}

export function TaskRunMotion({
  summary,
  level,
  model,
  diagram,
  viewport,
  source = taskRunMoves,
  reducedMotion,
}: {
  summary: PipelineSummary;
  level: AtlasGraphLevel;
  model: Pick<AtlasMachineFlow, "transitions">;
  diagram: DiagramTimeline;
  /** The Graph's viewport: travel pauses while it is off-screen. */
  viewport?: RefObject<HTMLElement | null>;
  source?: MoveSource;
  reducedMotion?: boolean;
}) {
  const prefersReduced = useReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;
  const [travels, setTravels] = useState<readonly Travel[]>([]);
  const [now, setNow] = useState(0);
  const visible = useRef(true);
  // The latest inputs, read by the long-lived event subscription.
  const latest = useRef({ summary, level, model, diagram, reduced });
  latest.current = { summary, level, model, diagram, reduced };
  const seq = useRef(0);

  useEffect(() => {
    const el = viewport?.current;
    if (!el || typeof IntersectionObserver === "undefined") return;
    const io = new IntersectionObserver((entries) => {
      visible.current = entries.some((e) => e.isIntersecting);
    });
    io.observe(el);
    return () => io.disconnect();
  }, [viewport]);

  useEffect(
    () =>
      source((move) => {
        const { summary, level, model, diagram } = latest.current;
        if (!visible.current || document.hidden) return;
        const rail = railForMove(
          summary,
          level,
          model,
          move.from_step_id,
          move.to_step_id
        );
        if (!rail || !diagram.rails.some((r) => r.id === rail)) return;
        const start = performance.now();
        setTravels((current) =>
          current.length >= MAX_TRAVELLING
            ? current
            : [
                ...current,
                { key: `${move.task_run_id}:${seq.current++}`, rail, start },
              ]
        );
        setNow(start);
      }),
    [source]
  );

  const active = travels.length > 0;
  // Reduced motion: no travel; each card shows at its destination, then leaves.
  useEffect(() => {
    if (!reduced || travels.length === 0) return;
    const timer = setTimeout(() => {
      const t = performance.now();
      setTravels((c) => c.filter((m) => t - m.start < ARRIVE_MS));
    }, ARRIVE_MS);
    return () => clearTimeout(timer);
  }, [reduced, travels]);
  // Frames run only while a card travels; the loop ends with the last one.
  useEffect(() => {
    if (!active || reduced) return;
    let frame = requestAnimationFrame(function tick(t) {
      setNow(t);
      setTravels((c) => {
        const next = c.filter((m) => t - m.start < TRAVEL_MS);
        return next.length === c.length ? c : next;
      });
      frame = requestAnimationFrame(tick);
    });
    return () => cancelAnimationFrame(frame);
  }, [active, reduced]);

  if (!active) return null;
  const railById = new Map(diagram.rails.map((r) => [r.id, r]));
  return (
    <svg
      className="uv-taskrun-motion"
      width={diagram.width}
      height={diagram.height}
      viewBox={`0 0 ${diagram.width} ${diagram.height}`}
      aria-hidden="true"
      data-testid="taskrun-motion"
    >
      {travels.map((m) => {
        const rail = railById.get(m.rail);
        if (!rail) return null;
        const f = reduced ? 1 : Math.min(1, (now - m.start) / TRAVEL_MS);
        const p = along(rail.points, f);
        return (
          <rect
            key={m.key}
            className="uv-taskrun-card"
            data-rail={m.rail}
            x={p[0] - 13}
            y={p[1] - 9}
            width={26}
            height={18}
            rx={4}
          />
        );
      })}
    </svg>
  );
}
