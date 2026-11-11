import { memo } from "react";
import { PartBox } from "../fixtures";
import {
  DiagramInteractionContext,
  type DiagramInteraction,
} from "../interaction";
import { MachineDiagram } from "../MachineDiagram";
import { MachineDiagramViewport } from "../MachineDiagramViewport";
import { MachinePart } from "../MachinePart";
import { RailCards } from "../RailCards";
import { SvgText } from "../SvgText";
import { Wire } from "../Rail";
import { nameLabelLocal, regionLabelAt } from "./extent";
import { useFlowRegistry } from "./registryContext";
import type { DiagramTimeline } from "./compile";

export interface FlowDiagramProps {
  diagram: DiagramTimeline;
  t: number;
  /** Accessible name of the picture (defaults to the arrangement). */
  label?: string;
  /** Override the prefers-reduced-motion media query. */
  reducedMotion?: boolean;
  /** Makes parts focusable/activatable and cards followable. */
  interaction?: DiagramInteraction;
}

/**
 * A compiled flow arrangement at time `t`: regions behind everything, a wire per rail, a MachinePart per
 * part (framed by its bounding box, named above it when drawn below full
 * scale, where MachinePart hides its own title), and the rail layer's
 * travelling cards, inside the pan/zoom viewport. Absent parts and rails are
 * not drawn. Works
 * for any registered part kind: everything comes from the compiled timeline.
 * With `interaction`, parts take hover, focus and activation and cards can
 * be followed. Memoized: under reduced motion the clock ticks every frame
 * while `t` stays on a beat outcome, and those frames skip the diagram.
 */
export const FlowDiagram = memo(function FlowDiagram({
  diagram: d,
  t,
  label,
  reducedMotion,
  interaction,
}: FlowDiagramProps) {
  const registry = useFlowRegistry();
  return (
    <DiagramInteractionContext.Provider value={interaction ?? null}>
      <MachineDiagramViewport width={d.width} height={d.height} fitOnMount>
        <MachineDiagram
          label={label ?? `flow · ${d.arrangement}`}
          width={d.width}
          height={d.height}
        >
          {d.regions.map((g) => (
            <g key={g.id} className="md-region" data-region-id={g.id}>
              <rect
                x={g.x}
                y={g.y}
                width={g.width}
                height={g.height}
                rx={18}
                fill="none"
              />
              {g.label && (
                <SvgText
                  x={regionLabelAt(g)[0]}
                  y={regionLabelAt(g)[1]}
                  runs={[[g.label, 600, "dim"]]}
                  size={18}
                />
              )}
            </g>
          ))}
          {d.rails
            .filter((r) => r.presence !== "absent")
            .map((r) => (
              <Wire
                key={r.id}
                points={r.points}
                change={r.change === "unchanged" ? "" : r.change}
                label={r.label}
                labelAt={r.labelAt}
              />
            ))}
          {d.parts
            .filter((p) => p.presence !== "absent")
            .map((p) => (
              <MachinePart
                key={p.id}
                id={p.id}
                part={p.identity}
                bb={p.bb}
                timeline={p.timeline}
                t={t}
                view={{ kind: "scenario", name: d.arrangement }}
                change={p.change}
                changeNote={p.changeNote}
                status={p.status}
                x={p.position.x}
                y={p.position.y}
                scale={p.scale}
                reducedMotion={reducedMotion}
              >
                {(frame) => {
                  const draw = registry.parts.get(p.kind)?.draw;
                  return draw ? (
                    draw(frame.t, p)
                  ) : (
                    <PartBox x={p.bb[0]} y={p.bb[1]} w={p.bb[2]} h={p.bb[3]} />
                  );
                }}
              </MachinePart>
            ))}
          {d.parts
            .filter((p) => p.presence !== "absent" && p.scale < 1)
            .map((p) => (
              <SvgText
                key={`name:${p.id}`}
                x={p.position.x + nameLabelLocal(p)[0]}
                y={p.position.y + nameLabelLocal(p)[1]}
                runs={[[p.identity.name, 600, "ink"]]}
                size={20}
                align="center"
              />
            ))}
          <RailCards timeline={d.travel} t={t} reducedMotion={reducedMotion} />
        </MachineDiagram>
      </MachineDiagramViewport>
    </DiagramInteractionContext.Provider>
  );
});
