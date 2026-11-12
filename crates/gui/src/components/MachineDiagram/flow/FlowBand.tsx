import { pop } from "../motion";
import { roleColor } from "../palette";
import { SvgText } from "../SvgText";
import {
  BAND_CHIP_HEIGHT,
  BAND_CHIP_LINK,
  BAND_CHIP_SIZE,
  BAND_DIVIDER,
  BAND_FOOTNOTE_SIZE,
  BAND_HEADING_SIZE,
  BAND_HEADING_SPACING,
  BAND_METER_RING,
  BAND_NAME_SIZE,
  BAND_NOTE_SEP,
  bandRowLit,
  chipTextX,
  meterCount,
  meterCountX,
  ringX,
  type DiagramBand,
  type DiagramBandMeter,
  type DiagramBandRow,
} from "./band";
import { bandRowDiffers } from "./morph";

/** Lit chips take an amber wash at this alpha (the prototype's 0.18). */
const LIT_FILL = 0.18;

/** The band being left during a Before/After morph, at its frozen time. */
export interface BandMorph {
  readonly from: DiagramBand;
  readonly t: number;
  /** Eased progress, 0 → 1. */
  readonly e: number;
}

/**
 * The band under a flow diagram at shown time `t`: the divider, heading,
 * one row per situation (lit amber while the story is in one of its beats)
 * and the meter. Geometry comes from the compiled band; only `t` changes
 * what is lit and filled. During a Before/After morph the divider and
 * heading stay put; rows and the meter that read differently cross-fade
 * from the band being left.
 */
export function FlowBand({
  band: b,
  t,
  reducedMotion,
  morph,
}: {
  band: DiagramBand;
  t: number;
  reducedMotion?: boolean;
  morph?: BandMorph;
}) {
  const fromRow = (i: number) => {
    const r = morph?.from.rows[i];
    if (!morph || !r) return undefined;
    const to = b.rows[i];
    const differs =
      !to ||
      bandRowDiffers(r, to) ||
      bandRowLit(r, morph.t) !== bandRowLit(to, t);
    return differs ? r : undefined;
  };
  const fm = morph?.from.meter;
  const meterDiffers =
    morph !== undefined &&
    fm !== undefined &&
    (!b.meter ||
      meterCount(fm, morph.t) !== meterCount(b.meter, t) ||
      fm.times.length !== b.meter.times.length ||
      fm.footnote !== b.meter.footnote);
  return (
    <g className="md-band" data-testid="flow-band">
      <rect
        x={b.x0}
        y={b.y}
        width={b.x1 - b.x0}
        height={BAND_DIVIDER}
        fill={roleColor("div")}
      />
      {b.heading && (
        <SvgText
          x={b.x0}
          y={b.headingY}
          runs={[[b.heading, 600, "dim"]]}
          size={BAND_HEADING_SIZE}
          letterSpacing={BAND_HEADING_SPACING}
        />
      )}
      {b.rows.map((r, i) => {
        const from = fromRow(i);
        const row = (
          <BandRow key={i} index={i} x={b.x0} row={r} lit={bandRowLit(r, t)} />
        );
        return from ? (
          <g key={i}>
            {row}
            <g opacity={1 - morph!.e} aria-hidden data-morph-from="band-row">
              <BandRow
                index={i}
                x={morph!.from.x0}
                row={from}
                lit={bandRowLit(from, morph!.t)}
                leaving
              />
            </g>
          </g>
        ) : (
          row
        );
      })}
      {b.meter && (
        <BandMeter meter={b.meter} t={t} reducedMotion={reducedMotion} />
      )}
      {meterDiffers && (
        <g opacity={1 - morph!.e} aria-hidden data-morph-from="band-meter">
          <BandMeter
            meter={fm!}
            t={morph!.t}
            reducedMotion={reducedMotion}
            leaving
          />
        </g>
      )}
    </g>
  );
}

/** `leaving`: the morph's outgoing copy, kept out of test and state hooks. */
function BandRow({
  index,
  x,
  row: r,
  lit,
  leaving,
}: {
  index: number;
  x: number;
  row: DiagramBandRow;
  lit: boolean;
  leaving?: boolean;
}) {
  const h = BAND_CHIP_HEIGHT;
  return (
    <g
      className="md-band-row"
      data-band-row={leaving ? undefined : index}
      data-lit={leaving ? undefined : lit ? "true" : "false"}
    >
      <SvgText
        x={x}
        y={r.y}
        runs={[
          [r.name, 600, "ink"],
          ...(r.note
            ? [[`${BAND_NOTE_SEP}${r.note}`, 400, "dim"] as const]
            : []),
        ]}
        size={BAND_NAME_SIZE}
      />
      {r.chips.map((c, k) => (
        <g key={k} className="md-band-chip">
          {k > 0 && (
            <line
              x1={c.x - BAND_CHIP_LINK}
              y1={r.y}
              x2={c.x}
              y2={r.y}
              stroke={roleColor("edge")}
              strokeWidth={1.2}
              strokeDasharray="3 3"
            />
          )}
          <rect
            x={c.x}
            y={r.y - h / 2}
            width={c.width}
            height={h}
            rx={6}
            fill={lit ? roleColor("amber") : "none"}
            fillOpacity={lit ? LIT_FILL : undefined}
            stroke={roleColor(lit ? "amber" : "edge")}
            strokeWidth={1.2}
            strokeDasharray="4 3"
          />
          <SvgText
            x={chipTextX(c)}
            y={r.y}
            runs={[[c.text, 400, lit ? "amber" : "dim"]]}
            size={BAND_CHIP_SIZE}
          />
        </g>
      ))}
    </g>
  );
}

function BandMeter({
  meter: m,
  t,
  reducedMotion,
  leaving,
}: {
  meter: DiagramBandMeter;
  t: number;
  reducedMotion?: boolean;
  leaving?: boolean;
}) {
  const n = meterCount(m, t);
  const total = m.times.length;
  return (
    <g
      className="md-band-meter"
      {...(leaving
        ? {}
        : {
            "data-testid": "flow-band-meter",
            "data-count": n,
            "data-total": total,
          })}
    >
      <SvgText
        x={m.x}
        y={m.labelY}
        runs={[[m.label, 600, "ink"]]}
        size={BAND_NAME_SIZE}
      />
      {m.times.map((at, i) => {
        const k = at > t ? 0 : reducedMotion ? 1 : Math.max(0, pop(t - at));
        return (
          <g key={i} data-filled={at <= t ? "true" : "false"}>
            <circle
              cx={ringX(m, i)}
              cy={m.ringsY}
              r={BAND_METER_RING}
              fill="none"
              stroke={roleColor("rail")}
              strokeWidth={2}
            />
            {k > 0 && (
              <circle
                cx={ringX(m, i)}
                cy={m.ringsY}
                r={(BAND_METER_RING - 3) * k}
                fill={roleColor("amber")}
              />
            )}
          </g>
        );
      })}
      <SvgText
        x={meterCountX(m, total)}
        y={m.ringsY}
        runs={[
          [String(n), 600, "amber"],
          [` of ${total}`, 400, "dim"],
        ]}
        size={BAND_NAME_SIZE}
      />
      {m.footnote && (
        <SvgText
          x={m.x}
          y={m.footnoteY}
          runs={[[m.footnote, 400, "dim"]]}
          size={BAND_FOOTNOTE_SIZE}
        />
      )}
    </g>
  );
}
