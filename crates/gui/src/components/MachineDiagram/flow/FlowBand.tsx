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

/** Lit chips take an amber wash at this alpha (the prototype's 0.18). */
const LIT_FILL = 0.18;

/**
 * The band under a flow diagram at shown time `t`: the divider, heading,
 * one row per situation (lit amber while the story is in one of its beats)
 * and the meter. Geometry comes from the compiled band; only `t` changes
 * what is lit and filled.
 */
export function FlowBand({
  band: b,
  t,
  reducedMotion,
}: {
  band: DiagramBand;
  t: number;
  reducedMotion?: boolean;
}) {
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
      {b.rows.map((r, i) => (
        <BandRow key={i} index={i} x={b.x0} row={r} lit={bandRowLit(r, t)} />
      ))}
      {b.meter && (
        <BandMeter meter={b.meter} t={t} reducedMotion={reducedMotion} />
      )}
    </g>
  );
}

function BandRow({
  index,
  x,
  row: r,
  lit,
}: {
  index: number;
  x: number;
  row: DiagramBandRow;
  lit: boolean;
}) {
  const h = BAND_CHIP_HEIGHT;
  return (
    <g
      className="md-band-row"
      data-band-row={index}
      data-lit={lit ? "true" : "false"}
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
}: {
  meter: DiagramBandMeter;
  t: number;
  reducedMotion?: boolean;
}) {
  const n = meterCount(m, t);
  const total = m.times.length;
  return (
    <g
      className="md-band-meter"
      data-testid="flow-band-meter"
      data-count={n}
      data-total={total}
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
