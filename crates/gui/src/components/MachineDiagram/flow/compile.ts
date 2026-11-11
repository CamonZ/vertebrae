/**
 * The flow compiler: a validated spec → one diagram-level timeline per
 * arrangement (Before/After, or `current`). All parts share one clock: each
 * part gets its own `Timeline` (part space, evaluated by MachinePart with
 * `stateAt`), and cards travelling between parts ride the diagram's rail
 * layer, handed from part to part with a stable id. Beats carry
 * diagram-wide captions; markers record spawns, arrivals and checkpoints.
 *
 * The compiler only sequences steps and moves cards along rails; what a
 * verb does inside a part comes from the part registry.
 */
import type { ChangeMark, PartIdentity } from "../accessibility";
import type { BBox } from "../ChangeMark";
import {
  FOOTPRINT_SCALE,
  PART_HEIGHT,
  PART_WIDTH,
  type Footprint,
} from "../MachinePart";
import type { StateRole } from "../palette";
import { railBetween, route, type Point, type PortSide } from "../route";
import {
  seal,
  story,
  type Beat,
  type CardPayload,
  type CardSpec,
  type StoryDraft,
  type Timeline,
  type TimelineMarker,
} from "../timeline";
import { FlowSpecErrors, type FlowSpecError } from "./errors";
import { withDefaults } from "./fields";
import { createFlowRegistry } from "./defaults";
import {
  HELD,
  TOKEN_SHAPES,
  tokenCard,
  type AnyPartKind,
  type FlowRegistry,
  type PartWriter,
  type StepCard,
} from "./registry";
import type {
  ArrangementName,
  AttachmentSpec,
  Caption,
  CardDecl,
  FlowSpec,
  PartSpec,
  Position,
  StepSpec,
  TokenKind,
  WireChangeMark,
} from "./spec";
import { resolvedProps, validateFlowSpec } from "./validate";

/** The first beat starts 0.6 s in, as every gallery story does. */
export const STORY_LEAD = 0.6;
/** Pause between beats. */
export const BEAT_GAP = 0.3;
/** How long a caption-only beat holds. */
export const CAPTION_HOLD = 1.6;
/** The final beat stays readable before the 0.6 s loop fade (VL-06). */
export const END_HOLD = 2.4;
/** Gap between cells in the fallback row layout. */
export const LAYOUT_GAP = 40;

/**
 * Seconds for a card to travel a rail of `length` px on the thrown spring:
 * 0.45 s for a short hop up to 0.75 s across a full diagram (the prototype's
 * rails run 0.55 s for ~250–430 px, 0.7–0.8 s for ~800 px).
 */
export function railTravel(length: number): number {
  return 0.45 + 0.3 * Math.min(1, length / 900);
}

export type Presence = "live" | "absent" | "removed";

export interface DiagramPort {
  readonly name: string;
  readonly side: PortSide;
  /** Diagram space. */
  readonly x: number;
  readonly y: number;
  /** Part space. */
  readonly local: Point;
  readonly dashed: boolean;
}

export type DrillTarget =
  | { readonly kind: "inline"; readonly flow: CompiledFlow }
  | { readonly kind: "artifact"; readonly artifact: string };

export interface DiagramPart {
  readonly id: string;
  readonly kind: string;
  readonly identity: PartIdentity;
  readonly footprint: Footprint;
  readonly scale: number;
  /** Top-left of the part's 640×400 cell in diagram space. */
  readonly position: Position;
  readonly positioned: "given" | "layout";
  readonly bb: BBox;
  readonly status: { readonly x: number; readonly y: number };
  /** Mark drawn in this arrangement (Before draws everything unchanged). */
  readonly change: ChangeMark;
  readonly changeNote?: string;
  readonly presence: Presence;
  readonly props: Readonly<Record<string, unknown>>;
  readonly ports: Readonly<Record<string, DiagramPort>>;
  /** The part's own timeline on the shared clock, in part space. */
  readonly timeline: Timeline;
  readonly attachments: readonly AttachmentSpec[];
  readonly drill?: DrillTarget;
}

export interface DiagramRail {
  readonly id: string;
  readonly from: { readonly part: string; readonly port: string };
  readonly to: { readonly part: string; readonly port: string };
  /** Orthogonal polyline in diagram space (pass to `route` / `Wire`). */
  readonly points: readonly Point[];
  readonly label?: string;
  readonly conditional: boolean;
  readonly change: WireChangeMark;
  readonly presence: Presence;
  readonly attachments: readonly AttachmentSpec[];
}

export interface CompiledCard {
  readonly id: string;
  readonly token: TokenKind;
  readonly label: string;
  readonly payload?: CardPayload;
  readonly attachments: readonly AttachmentSpec[];
}

export interface CompiledBeat extends Beat {
  readonly attachments: readonly AttachmentSpec[];
}

export interface DiagramTimeline {
  readonly arrangement: ArrangementName;
  readonly period: number;
  readonly width: number;
  readonly height: number;
  readonly parts: readonly DiagramPart[];
  readonly rails: readonly DiagramRail[];
  /** Cards on rails between parts, in diagram space; beats as captions. */
  readonly travel: Timeline;
  readonly beats: readonly CompiledBeat[];
  /** Every marker of every part plus rail arrivals, sorted by time. */
  readonly markers: readonly TimelineMarker[];
  /** Marker counts by kind, e.g. `{ spawn: 4, close: 4 }`. */
  readonly counts: Readonly<Record<string, number>>;
}

export interface CompiledFlow {
  readonly version: number;
  readonly title?: string;
  /** `[before, after]` for a spec with change marks, otherwise `[current]`. */
  readonly arrangements: readonly DiagramTimeline[];
  readonly cards: Readonly<Record<string, CompiledCard>>;
  readonly attachments: readonly AttachmentSpec[];
}

export type CompileResult =
  | { readonly ok: true; readonly flow: CompiledFlow }
  | { readonly ok: false; readonly errors: readonly FlowSpecError[] };

export interface LayoutPart {
  readonly id: string;
  readonly kind: string;
  readonly scale: number;
  /** Cell size in diagram space. */
  readonly width: number;
  readonly height: number;
  readonly position?: Position;
}

export interface LayoutRail {
  readonly id: string;
  readonly from: string;
  readonly to: string;
}

/** Fills in positions for parts without one (auto-layout, ticket 5985798a, plugs in here). */
export type LayoutFn = (
  parts: readonly LayoutPart[],
  rails: readonly LayoutRail[]
) => Readonly<Record<string, Position>>;

/** Fallback layout: unplaced parts in one row after the placed ones, rail-centred. */
export const rowLayout: LayoutFn = (parts) => {
  const out: Record<string, Position> = {};
  let x = 0;
  for (const p of parts)
    if (p.position) x = Math.max(x, p.position.x + p.width + LAYOUT_GAP);
  const rowH = Math.max(...parts.map((p) => p.height));
  for (const p of parts) {
    if (p.position) continue;
    out[p.id] = { x, y: (rowH - p.height) / 2 };
    x += p.width + LAYOUT_GAP;
  }
  return out;
};

export interface CompileOptions {
  registry?: FlowRegistry;
  layout?: LayoutFn;
}

/** Validate and compile a parsed spec. */
export function compileFlow(
  input: unknown,
  o: CompileOptions = {}
): CompileResult {
  const registry = o.registry ?? createFlowRegistry();
  const errors = validateFlowSpec(input, registry);
  if (errors.length) return { ok: false, errors };
  const spec = input as FlowSpec;
  const runtime: FlowSpecError[] = [];
  const flow = build(spec, registry, o.layout ?? rowLayout, runtime, "");
  return runtime.length ? { ok: false, errors: runtime } : { ok: true, flow };
}

/** Like `compileFlow`, but throws `FlowSpecErrors`. */
export function compileFlowOrThrow(
  input: unknown,
  o: CompileOptions = {}
): CompiledFlow {
  const r = compileFlow(input, o);
  if (!r.ok) throw new FlowSpecErrors(r.errors);
  return r.flow;
}

export function arrangementsOf(spec: FlowSpec): ArrangementName[] {
  const changed =
    spec.parts.some(
      (p) => (p.change && p.change !== "unchanged") || p.before || p.after
    ) || (spec.rails ?? []).some((r) => r.change && r.change !== "unchanged");
  return changed ? ["before", "after"] : ["current"];
}

function build(
  spec: FlowSpec,
  registry: FlowRegistry,
  layout: LayoutFn,
  errors: FlowSpecError[],
  root: string
): CompiledFlow {
  const defs = new Map(
    spec.parts.map((p) => [p.id, registry.parts.get(p.kind)!])
  );
  const scaleOf = (p: PartSpec) =>
    p.scale ?? FOOTPRINT_SCALE[defs.get(p.id)!.footprint];
  const layoutParts: LayoutPart[] = spec.parts.map((p) => ({
    id: p.id,
    kind: p.kind,
    scale: scaleOf(p),
    width: PART_WIDTH * scaleOf(p),
    height: PART_HEIGHT * scaleOf(p),
    position: p.position,
  }));
  const placed = layout(
    layoutParts,
    (spec.rails ?? []).map((r) => ({
      id: r.id,
      from: r.from.slice(0, r.from.lastIndexOf(".")),
      to: r.to.slice(0, r.to.lastIndexOf(".")),
    }))
  );
  const positions = new Map(
    spec.parts.map((p) => [p.id, p.position ?? placed[p.id] ?? { x: 0, y: 0 }])
  );
  const drills = new Map<string, DrillTarget>();
  spec.parts.forEach((p, i) => {
    if (!p.drill) return;
    drills.set(
      p.id,
      "artifact" in p.drill
        ? { kind: "artifact", artifact: p.drill.artifact }
        : {
            kind: "inline",
            flow: build(
              p.drill.spec,
              registry,
              layout,
              errors,
              `${root}parts[${i}].drill.spec.`
            ),
          }
    );
  });
  const cards = Object.fromEntries(
    (spec.cards ?? []).map((c) => [
      c.id,
      {
        id: c.id,
        token: c.token,
        label: c.label ?? c.id,
        ...(c.payload ? { payload: c.payload } : {}),
        attachments: c.attachments ?? [],
      },
    ])
  );
  return {
    version: spec.version,
    ...(spec.title ? { title: spec.title } : {}),
    arrangements: arrangementsOf(spec).map((a) =>
      arrange(spec, a, defs, positions, scaleOf, drills, errors, root)
    ),
    cards,
    attachments: spec.attachments ?? [],
  };
}

interface PartRun {
  readonly spec: PartSpec;
  readonly def: AnyPartKind;
  readonly props: Record<string, unknown>;
  readonly state: unknown;
  readonly presence: Presence;
  readonly draft: StoryDraft;
  readonly markers: TimelineMarker[];
}

interface CardRun {
  readonly decl: CardDecl;
  /** Current token kind; a verb can change it while the id stays. */
  token: TokenKind;
  at: string | null;
  /** Port the last verb sent the card out by; the next rail must leave from it. */
  exit: string | null;
  role: StateRole;
  consumed: boolean;
}

function presenceOf(change: string | undefined, a: ArrangementName): Presence {
  if (a === "before" && change === "added") return "absent";
  if (a === "after" && change === "removed") return "removed";
  return "live";
}

function captionFor(
  c: Caption | undefined,
  a: ArrangementName
): string | undefined {
  if (c === undefined || typeof c === "string") return c;
  return a === "current" ? (c.after ?? c.before) : c[a];
}

function arrange(
  spec: FlowSpec,
  a: ArrangementName,
  defs: Map<string, AnyPartKind>,
  positions: Map<string, Position>,
  scaleOf: (p: PartSpec) => number,
  drills: Map<string, DrillTarget>,
  errors: FlowSpecError[],
  root: string
): DiagramTimeline {
  const fail = (path: string, message: string) =>
    errors.push({
      path: root + path,
      message:
        a === "current" ? message : `${message} (in the ${a} arrangement)`,
    });

  /* parts */
  const runs = new Map<string, PartRun>();
  for (const p of spec.parts) {
    const def = defs.get(p.id)!;
    const override =
      a === "before" ? p.before : a === "after" ? p.after : undefined;
    const props = resolvedProps(def, p.props, override?.props);
    runs.set(p.id, {
      spec: p,
      def,
      props,
      state: def.init?.(props) ?? {},
      presence: presenceOf(p.change, a),
      draft: story(0),
      markers: [],
    });
  }
  const portAt = (pid: string, port: string): DiagramPort => {
    const run = runs.get(pid)!;
    const pd = run.def.ports[port];
    const pos = positions.get(pid)!;
    const s = scaleOf(run.spec);
    return {
      name: port,
      side: pd.side,
      x: pos.x + pd.x * s,
      y: pos.y + pd.y * s,
      local: [pd.x, pd.y],
      dashed: pd.dashed ?? false,
    };
  };

  /* rails */
  const split = (end: string) => {
    const i = end.lastIndexOf(".");
    return { part: end.slice(0, i), port: end.slice(i + 1) };
  };
  const rails = new Map<string, DiagramRail>();
  const railTokens = new Map<string, readonly TokenKind[]>();
  for (const r of spec.rails ?? []) {
    const from = split(r.from);
    const to = split(r.to);
    const accepts = runs.get(to.part)!.def.ports[to.port].tokens;
    railTokens.set(
      r.id,
      runs
        .get(from.part)!
        .def.ports[from.port].tokens.filter((k) => accepts.includes(k))
    );
    const own = presenceOf(r.change, a);
    const ends = [runs.get(from.part)!.presence, runs.get(to.part)!.presence];
    const presence: Presence =
      own !== "live" ? own : (ends.find((e) => e !== "live") ?? "live");
    const pf = portAt(from.part, from.port);
    const pt = portAt(to.part, to.port);
    rails.set(r.id, {
      id: r.id,
      from,
      to,
      points: railBetween(pf, pt),
      ...(r.label ? { label: r.label } : {}),
      conditional: r.conditional ?? false,
      change: a === "before" ? "unchanged" : (r.change ?? "unchanged"),
      presence,
      attachments: r.attachments ?? [],
    });
  }

  /* cards */
  const cardRuns = new Map<string, CardRun>(
    (spec.cards ?? []).map((c) => [
      c.id,
      {
        decl: c,
        token: c.token,
        at: c.origin ?? null,
        exit: null,
        role: TOKEN_SHAPES[c.token].role,
        consumed: false,
      },
    ])
  );
  const stepCard = (c: CardRun): StepCard => ({
    id: c.decl.id,
    token: c.token,
    label: c.decl.label ?? c.decl.id,
    ...(c.decl.payload ? { payload: c.decl.payload } : {}),
    role: c.role,
  });

  const travel = story(0);
  const arrivals: Omit<TimelineMarker, "order">[] = [];
  const beats: CompiledBeat[] = [];

  const writer = (run: PartRun, card: StepCard | undefined): PartWriter => ({
    card: (c: CardSpec) => {
      run.draft.cards.push(c);
    },
    carry: (legs, born, dies, o = {}) => {
      if (!card)
        throw new Error(
          `${run.def.kind}: a verb carried a card but its step has none`
        );
      const { role, ...rest } = o;
      const first = legs[0];
      const c = tokenCard(card, role ?? card.role, legs, born, dies, {
        tags: [
          [
            card.label,
            born + 0.02,
            born + Math.max(0.3, (first?.[2] ?? 0.4) * 0.8),
          ],
        ],
        ...rest,
      });
      run.draft.cards.push(c);
      return c;
    },
    note: (t, text, role = "dim") => {
      run.draft.notes.push([t, text, role]);
    },
    marker: (m) => {
      run.markers.push({ ...m, part: run.spec.id });
    },
    end: (id, t) => {
      const cs = run.draft.cards;
      for (let i = cs.length - 1; i >= 0; i--) {
        if (cs[i].id === id && cs[i].dies >= HELD) {
          cs[i] = { ...cs[i], dies: t };
          return;
        }
      }
    },
  });

  let clock = STORY_LEAD;
  (spec.story ?? []).forEach((beat, b) => {
    const bp = `story[${b}]`;
    const caption = captionFor(beat.caption, a);
    const beatStart = clock;
    let groupStart = clock;
    let groupEnd = clock;
    let ran = 0;
    (beat.steps ?? []).forEach((step: StepSpec, k) => {
      const sp = `${bp}.steps[${k}]`;
      const run = runs.get(step.part)!;
      const rail = step.via ? rails.get(step.via)! : undefined;
      if (run.presence !== "live" || (rail && rail.presence !== "live")) return;
      const c = step.card ? cardRuns.get(step.card)! : undefined;
      if (c?.consumed) {
        fail(`${sp}.card`, `card "${c.decl.id}" has already ended`);
        return;
      }
      let t = (step.with ? groupStart : groupEnd) + (step.delay ?? 0);
      const start = t;
      if (rail && c) {
        if (c.at !== rail.from.part) {
          fail(
            `${sp}.via`,
            c.at === null
              ? `card "${c.decl.id}" has not been placed yet; rail "${rail.id}" starts at "${rail.from.part}" (give the card an origin or an earlier step there)`
              : `card "${c.decl.id}" is at "${c.at}", but rail "${rail.id}" starts at "${rail.from.part}"`
          );
          return;
        }
        if (c.exit !== null && c.exit !== rail.from.port) {
          fail(
            `${sp}.via`,
            `card "${c.decl.id}" left ${c.at} by its ${c.exit} port, but rail "${rail.id}" starts at ${c.at}.${rail.from.port}`
          );
          return;
        }
        const carries = railTokens.get(rail.id)!;
        if (!carries.includes(c.token)) {
          fail(
            `${sp}.card`,
            `card "${c.decl.id}" is a ${c.token}; rail "${rail.id}" carries ${carries.join(", ")}`
          );
          return;
        }
        const r = route(rail.points);
        const d = railTravel(r.length);
        travel.cards.push(
          tokenCard(stepCard(c), c.role, [[r, t, d]], t, t + d + 0.02, {
            tags: [[c.decl.label ?? c.decl.id, t + 0.02, t + d * 0.7]],
          })
        );
        t += d;
        arrivals.push({
          t,
          kind: "arrival",
          label: `${c.decl.label ?? c.decl.id} → ${step.part}`,
          part: step.part,
          card: c.decl.id,
          ...(c.decl.payload?.eventTime !== undefined
            ? { eventTime: c.decl.payload.eventTime }
            : {}),
        });
        c.at = step.part;
        c.exit = null;
      } else if (c) {
        if (c.at !== null && c.at !== step.part) {
          fail(
            `${sp}.card`,
            `card "${c.decl.id}" is at "${c.at}"; travel a rail (via) to bring it to "${step.part}"`
          );
          return;
        }
        c.at = step.part;
      }
      const verb = run.def.verbs[step.verb];
      if (c && verb.tokens && !verb.tokens.includes(c.token)) {
        fail(
          `${sp}.card`,
          `${run.def.kind} verb "${step.verb}" takes ${verb.tokens.join(", ")}; card "${c.decl.id}" is a ${c.token}`
        );
        return;
      }
      const sc = c ? stepCard(c) : undefined;
      const outcome =
        verb.compile({
          t,
          arrangement: a,
          part: {
            id: run.spec.id,
            kind: run.def.kind,
            label: run.spec.label ?? run.def.kind,
            props: run.props,
          },
          state: run.state,
          ...(sc ? { card: sc } : {}),
          ...(rail ? { entry: rail.to.port } : {}),
          args: withDefaults(step.args, verb.args ?? {}),
          out: writer(run, sc),
          port: (name: string) => {
            const pd = run.def.ports[name];
            return [pd.x, pd.y] as const;
          },
        }) ?? {};
      const end = t + (outcome.duration ?? verb.duration);
      if (c) {
        if (outcome.role) c.role = outcome.role;
        if (outcome.token) c.token = outcome.token;
        c.exit = outcome.exit ?? null;
        if (outcome.consumed) {
          c.consumed = true;
          c.at = null;
        }
      }
      if (step.checkpoint)
        run.markers.push({
          t: end,
          kind: "checkpoint",
          label: step.checkpoint,
          part: step.part,
          ...(c ? { card: c.decl.id } : {}),
        });
      groupStart = start;
      groupEnd = Math.max(groupEnd, end);
      ran++;
    });
    // A beat without a caption in this arrangement continues the previous one.
    if (caption !== undefined)
      beats.push({
        t: beatStart,
        caption,
        ...(beat.id ? { id: beat.id } : {}),
        attachments: beat.attachments ?? [],
      });
    if (ran === 0 && caption === undefined) return;
    clock = groupEnd + (beat.hold ?? (ran ? BEAT_GAP : CAPTION_HOLD));
  });

  // Arrival order per part follows arrival time (ties keep step order).
  const arrived = new Map<string, number>();
  const travelMarkers: TimelineMarker[] = [...arrivals]
    .sort((x, y) => x.t - y.t)
    .map((m) => {
      const order = (arrived.get(m.part!) ?? 0) + 1;
      arrived.set(m.part!, order);
      return { ...m, order };
    });

  const period = clock + END_HOLD;
  const finishDraft = (d: StoryDraft): Timeline => {
    d.period = period;
    d.cards = d.cards.map((c) => (c.dies >= HELD ? { ...c, dies: period } : c));
    return seal(d);
  };
  const plainBeats: Beat[] = beats.map(({ t, caption, id }) => ({
    t,
    caption,
    ...(id ? { id } : {}),
  }));

  const parts: DiagramPart[] = spec.parts.map((p) => {
    const run = runs.get(p.id)!;
    const s = scaleOf(p);
    const override =
      a === "before" ? p.before : a === "after" ? p.after : undefined;
    const changeNote = override?.changeNote ?? p.changeNote;
    const tl = finishDraft(run.draft);
    const drill = drills.get(p.id);
    return {
      id: p.id,
      kind: p.kind,
      identity: { name: p.label ?? p.kind, job: p.job ?? run.def.job },
      footprint: run.def.footprint,
      scale: s,
      position: positions.get(p.id)!,
      positioned: p.position ? "given" : "layout",
      bb: run.def.bb,
      status: run.def.status,
      change: a === "before" ? "unchanged" : (p.change ?? "unchanged"),
      ...(changeNote && a !== "before" ? { changeNote } : {}),
      presence: run.presence,
      props: run.props,
      ports: Object.fromEntries(
        Object.keys(run.def.ports).map((n) => [n, portAt(p.id, n)])
      ),
      timeline: {
        ...tl,
        gates:
          run.presence === "live" ? (run.def.gates?.(run.props) ?? []) : [],
        beats: plainBeats,
        markers: [...run.markers].sort((x, y) => x.t - y.t),
      },
      attachments: p.attachments ?? [],
      ...(drill ? { drill } : {}),
    };
  });

  const markers = [
    ...travelMarkers,
    ...[...runs.values()].flatMap((r) => r.markers),
  ].sort((x, y) => x.t - y.t);
  const counts: Record<string, number> = {};
  for (const m of markers) counts[m.kind] = (counts[m.kind] ?? 0) + 1;
  const width = Math.max(
    ...parts.map((p) => p.position.x + PART_WIDTH * p.scale)
  );
  const height = Math.max(
    ...parts.map((p) => p.position.y + PART_HEIGHT * p.scale)
  );

  return {
    arrangement: a,
    period,
    width,
    height,
    parts,
    rails: [...rails.values()],
    travel: {
      ...finishDraft(travel),
      beats: plainBeats,
      markers: travelMarkers,
    },
    beats,
    markers,
    counts,
  };
}

/** The diagram timeline for one arrangement. */
export function arrangement(
  flow: CompiledFlow,
  name: ArrangementName
): DiagramTimeline | undefined {
  return flow.arrangements.find((d) => d.arrangement === name);
}

/** Where a card is at `t`: on a rail (travel layer) or inside a part. */
export function cardTrack(
  d: DiagramTimeline,
  id: string
): {
  readonly layer: "rail" | string;
  readonly born: number;
  readonly dies: number;
}[] {
  const out: { layer: string; born: number; dies: number }[] = [];
  for (const c of d.travel.cards)
    if (c.id === id) out.push({ layer: "rail", born: c.born, dies: c.dies });
  for (const p of d.parts)
    for (const c of p.timeline.cards)
      if (c.id === id) out.push({ layer: p.id, born: c.born, dies: c.dies });
  return out.sort((x, y) => x.born - y.born);
}
