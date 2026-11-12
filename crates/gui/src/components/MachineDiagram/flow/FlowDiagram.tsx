import { memo, type ReactNode } from "react";
import { PortMark, StageMark } from "../ChangeMark";
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
import { DrillMark } from "./DrillMark";
import { nameLabelLocal, regionLabelAt } from "./extent";
import { FlowBand } from "./FlowBand";
import { useFlowRegistry } from "./registryContext";
import type { DiagramPart, DiagramRail, DiagramTimeline } from "./compile";
import {
  morphEase,
  morphLayers,
  partDiffers,
  railDiffers,
  type DiagramMorph,
} from "./morph";
import type { FlowRegistry } from "./registry";

/** Accessible note on a part with a drill-down. */
export const DRILL_HINT = "Opens a deeper diagram.";

export interface FlowDiagramProps {
  diagram: DiagramTimeline;
  t: number;
  /** Accessible name of the picture (defaults to the arrangement). */
  label?: string;
  /** Override the prefers-reduced-motion media query. */
  reducedMotion?: boolean;
  /** Makes parts focusable/activatable and cards followable. */
  interaction?: DiagramInteraction;
  /**
   * A Before/After morph in progress: `diagram` is arriving, `morph.from`
   * leaving. Parts and rails that read the same are drawn once; marked ones
   * blend (see morph.ts). The leaving copies are hidden from assistive tech
   * and take no input.
   */
  morph?: DiagramMorph;
}

/**
 * A compiled flow arrangement at time `t`: regions behind everything, a wire per rail, a MachinePart per
 * part (framed by its bounding box, named above it when drawn below full
 * scale, where MachinePart hides its own title, with its port and stage
 * marks), and the rail layer's
 * travelling cards, inside the pan/zoom viewport, with the band (if any)
 * under it all. Absent parts and rails are
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
  morph,
}: FlowDiagramProps) {
  const registry = useFlowRegistry();
  const e = morph ? morphEase(morph.progress) : undefined;
  const fromPart = new Map(morph?.from.parts.map((p) => [p.id, p]));
  const fromRail = new Map(morph?.from.rails.map((r) => [r.id, r]));
  const parts = d.parts.map((p) => ({
    p,
    from: fromPart.get(p.id),
    layers: morphLayers(p, fromPart.get(p.id), e, partDiffers),
  }));
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
          {d.rails.map((r) => {
            const from = fromRail.get(r.id);
            const l = morphLayers(r, from, e, railDiffers);
            return (
              <Layered
                key={r.id}
                layers={l}
                to={() => <RailWire rail={r} />}
                from={() => <RailWire rail={from!} />}
              />
            );
          })}
          {parts.map(({ p, from, layers }) => (
            <Layered
              key={p.id}
              layers={layers}
              to={() => (
                <PartView
                  part={p}
                  t={t}
                  arrangement={d.arrangement}
                  registry={registry}
                  reducedMotion={reducedMotion}
                  markMorph={layers.morphing ? e : undefined}
                />
              )}
              from={() => (
                // The leaving copy: frozen at the toggle, no id or input.
                <DiagramInteractionContext.Provider value={null}>
                  <PartView
                    part={from!}
                    t={morph!.t}
                    arrangement={morph!.from.arrangement}
                    registry={registry}
                    reducedMotion={reducedMotion}
                    leaving
                  />
                </DiagramInteractionContext.Provider>
              )}
            />
          ))}
          {parts
            .filter(({ p }) => p.scale < 1)
            .map(({ p, from, layers }) => (
              <Layered
                key={`name:${p.id}`}
                layers={layers}
                to={() => <NameLabel part={p} />}
                from={() => <NameLabel part={from!} />}
              />
            ))}
          {d.band && (
            <FlowBand
              band={d.band}
              t={t}
              reducedMotion={reducedMotion}
              morph={
                morph?.from.band && e !== undefined && e < 1
                  ? { from: morph.from.band, t: morph.t, e }
                  : undefined
              }
            />
          )}
          <RailCards timeline={d.travel} t={t} reducedMotion={reducedMotion} />
        </MachineDiagram>
      </MachineDiagramViewport>
    </DiagramInteractionContext.Provider>
  );
});

/**
 * One element's morph layers: the arriving copy underneath, the leaving one
 * over it (`data-morph-from`, hidden from assistive tech). Drawn bare when
 * nothing blends, so unchanged elements render exactly as without a morph.
 */
function Layered({
  layers,
  to,
  from,
}: {
  layers: ReturnType<typeof morphLayers>;
  to: () => ReactNode;
  from: () => ReactNode;
}) {
  if (!layers.morphing) return layers.to !== undefined ? to() : null;
  return (
    <>
      {layers.to !== undefined &&
        (layers.to < 1 ? (
          <g opacity={layers.to} data-morph-to="">
            {to()}
          </g>
        ) : (
          to()
        ))}
      {layers.from !== undefined && (
        <g
          opacity={layers.from}
          data-morph-from=""
          aria-hidden
          pointerEvents="none"
        >
          {from()}
        </g>
      )}
    </>
  );
}

function RailWire({ rail: r }: { rail: DiagramRail }) {
  return (
    <Wire
      points={r.points}
      change={r.change === "unchanged" ? "" : r.change}
      label={r.label}
      labelAt={r.labelAt}
    />
  );
}

function NameLabel({ part: p }: { part: DiagramPart }) {
  return (
    <SvgText
      x={p.position.x + nameLabelLocal(p)[0]}
      y={p.position.y + nameLabelLocal(p)[1]}
      runs={[[p.identity.name, 600, "ink"]]}
      size={20}
      align="center"
    />
  );
}

function PartView({
  part: p,
  t,
  arrangement,
  registry,
  reducedMotion,
  markMorph,
  leaving,
}: {
  part: DiagramPart;
  t: number;
  arrangement: string;
  registry: FlowRegistry;
  reducedMotion?: boolean;
  markMorph?: number;
  /** The morph's leaving copy: no `data-part-id`, so lookups find the live part. */
  leaving?: boolean;
}) {
  return (
    <MachinePart
      id={leaving ? undefined : p.id}
      part={p.identity}
      bb={p.bb}
      timeline={p.timeline}
      t={t}
      view={{ kind: "scenario", name: arrangement }}
      change={p.change}
      changeNote={p.changeNote}
      markMorph={markMorph}
      status={p.status}
      x={p.position.x}
      y={p.position.y}
      scale={p.scale}
      reducedMotion={reducedMotion}
      activationHint={p.drill && !leaving ? DRILL_HINT : undefined}
    >
      {(frame) => {
        const draw = registry.parts.get(p.kind)?.draw;
        return (
          <>
            {draw ? (
              draw(frame.t, p)
            ) : (
              <PartBox x={p.bb[0]} y={p.bb[1]} w={p.bb[2]} h={p.bb[3]} />
            )}
            {p.drill && <DrillMark bb={p.bb} scale={p.scale} />}
            {p.stageMarks.map((s) => (
              <StageMark
                key={s.name}
                mark={s.change}
                name={s.name}
                bb={s.bb}
                tag={s.tag}
              />
            ))}
            {Object.entries(p.portChanges).map(([name, mark]) => {
              const port = p.ports[name];
              return port ? (
                <PortMark
                  key={name}
                  mark={mark}
                  name={name}
                  x={port.local[0]}
                  y={port.local[1]}
                  side={port.side}
                />
              ) : null;
            })}
          </>
        );
      }}
    </MachinePart>
  );
}
