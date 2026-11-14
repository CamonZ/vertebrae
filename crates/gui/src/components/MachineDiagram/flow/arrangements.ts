/**
 * Which arrangements a spec compiles to, and how each one reads a part, rail,
 * step, caption or per-arrangement value.
 *
 * Two forms describe the same thing. Named arrangements (`arrangements:`)
 * give presence: a part, rail or step is `in` some arrangements, and its
 * marks are computed against the baseline (added: not in the baseline,
 * removed: only in the baseline, changed: its override differs). The
 * Before/After shorthand gives marks instead (an added part is only After,
 * a removed one only Before), and compiles to `[before, after]` with
 * `before` as the baseline; a spec with neither compiles to `[current]`.
 *
 * Phases (`phases:`) are named arrangements the story moves through in
 * order: each beat belongs to one phase, and each phase is marked against
 * the phase before it (what that step of the migration adds, changes or
 * removes), the first phase drawing no marks.
 *
 * Everything here assumes a validated spec.
 */
import type { ChangeMark } from "../accessibility";
import { own } from "./fields";
import type {
  ArrangementDecl,
  ArrangementName,
  ArrangementOverride,
  Caption,
  FlowSpec,
  PartSpec,
  RailSpec,
  StepSpec,
  WireChangeMark,
} from "./spec";

/** How a part or rail is drawn: in the arrangement, ghosted (removed from the baseline), or not at all. */
export type Presence = "live" | "absent" | "removed";

/** Display names of the shorthand's arrangements. */
const SHORTHAND_LABELS: Readonly<Record<string, string>> = {
  before: "Before",
  after: "After",
  current: "Current",
};

export interface ArrangementPlan {
  /** Arrangements in spec order, the baseline among them. */
  readonly names: readonly ArrangementName[];
  /** Marks are computed against this arrangement; it draws none itself. */
  readonly baseline: ArrangementName;
  /** What the player shows for each name. */
  readonly labels: Readonly<Record<ArrangementName, string>>;
  /** Named arrangements (presence via `in`) rather than the shorthand. */
  readonly named: boolean;
  /** Phases: the story, not the reader, picks the arrangement. */
  readonly phased: boolean;
  /** Phased: the phase of each story beat, by story index (empty otherwise). */
  readonly beatPhases: readonly ArrangementName[];
}

/** A part as one arrangement draws it. */
export interface PartReading {
  readonly presence: Presence;
  readonly change: ChangeMark;
  readonly changeNote?: string;
  /** Props and note overrides that apply in this arrangement. */
  readonly override?: ArrangementOverride;
  readonly portChanges: Readonly<Record<string, ChangeMark>>;
  readonly stageChanges: Readonly<Record<string, ChangeMark>>;
}

export interface RailReading {
  readonly presence: Presence;
  readonly change: WireChangeMark;
}

const marked = (m: string | undefined) => m !== undefined && m !== "unchanged";
const anyMarked = (r: Readonly<Record<string, string>> | undefined) =>
  Object.values(r ?? {}).some(marked);

export const declName = (d: ArrangementDecl) =>
  typeof d === "string" ? d : d.name;

/** The arrangements of a spec, its baseline and their labels. */
export function planOf(spec: FlowSpec): ArrangementPlan {
  const decls = spec.phases ?? spec.arrangements;
  if (decls) {
    const names = decls.map(declName);
    return {
      names,
      baseline: spec.phases ? names[0] : (spec.baseline ?? names[0]),
      labels: Object.fromEntries(
        decls.map((d) => [
          declName(d),
          (typeof d === "string" ? undefined : d.label) ??
            SHORTHAND_LABELS[declName(d)] ??
            declName(d),
        ])
      ),
      named: true,
      phased: spec.phases !== undefined,
      beatPhases: spec.phases ? beatPhases(spec.story ?? [], names) : [],
    };
  }
  const changed =
    spec.parts.some(
      (p) =>
        marked(p.change) ||
        p.before ||
        p.after ||
        anyMarked(p.portChanges) ||
        anyMarked(p.stageChanges)
    ) ||
    (spec.rails ?? []).some((r) => marked(r.change)) ||
    (spec.story ?? []).some((b) =>
      (b.steps ?? []).some((s) => marked(s.change))
    );
  const names = changed ? ["before", "after"] : ["current"];
  return {
    names,
    baseline: names[0],
    labels: Object.fromEntries(names.map((n) => [n, SHORTHAND_LABELS[n]])),
    named: false,
    phased: false,
    beatPhases: [],
  };
}

/** The phase of each beat: the last one a beat at or before it started (the first phase before any). */
function beatPhases(
  story: readonly { readonly phase?: string }[],
  names: readonly ArrangementName[]
): ArrangementName[] {
  let current = names[0];
  return story.map((b) => (current = b.phase ?? current));
}

/** The marked entries of a name → mark record. */
function only(
  r: Readonly<Record<string, ChangeMark>> | undefined
): Record<string, ChangeMark> {
  return Object.fromEntries(
    Object.entries(r ?? {}).filter(([, m]) => m !== "unchanged")
  );
}

/** Whether a step marked `change` runs in shorthand arrangement `a` (+ only After, − only Before). */
export function stepRuns(change: string | undefined, a: ArrangementName) {
  if (change === "added") return a !== "before";
  if (change === "removed") return a === "before";
  return true;
}

function shorthandPresence(change: string | undefined, a: ArrangementName) {
  if (a === "before" && change === "added") return "absent";
  if (a === "after" && change === "removed") return "removed";
  return "live";
}

/** Presence from membership: in `a`; only in the baseline (ghosted); or in neither. */
function presenceIn(
  members: ReadonlySet<string>,
  a: ArrangementName,
  baseline: ArrangementName
): Presence {
  if (members.has(a)) return "live";
  return members.has(baseline) ? "removed" : "absent";
}

/** Mark from membership against the baseline. */
function markIn(
  members: ReadonlySet<string>,
  a: ArrangementName,
  baseline: ArrangementName
): "unchanged" | "added" | "removed" {
  if (a === baseline || members.has(a) === members.has(baseline))
    return "unchanged";
  return members.has(a) ? "added" : "removed";
}

/**
 * Reads the spec's parts, rails and steps in each arrangement. `props`
 * resolves a part's props under an override (base + override + defaults),
 * which tells a changed part from an unchanged one.
 */
export class Arrangements {
  readonly plan: ArrangementPlan;
  private readonly parts: ReadonlyMap<string, PartSpec>;
  private readonly rails: ReadonlyMap<string, RailSpec>;

  constructor(
    readonly spec: FlowSpec,
    private readonly props: (
      p: PartSpec,
      o: ArrangementOverride | undefined
    ) => Readonly<Record<string, unknown>>
  ) {
    this.plan = planOf(spec);
    this.parts = new Map(spec.parts.map((p) => [p.id, p]));
    this.rails = new Map((spec.rails ?? []).map((r) => [r.id, r]));
  }

  private all(list: readonly string[] | undefined): ReadonlySet<string> {
    return new Set(list ?? this.plan.names);
  }

  /** Named: the arrangements a part is in. */
  partMembers(id: string): ReadonlySet<string> {
    return this.all(this.parts.get(id)?.in);
  }

  /** Named: the arrangements a rail is in — its own, where both its parts are. */
  railMembers(id: string): ReadonlySet<string> {
    const r = this.rails.get(id)!;
    const own = this.all(r.in);
    const from = this.partMembers(r.from.slice(0, r.from.lastIndexOf(".")));
    const to = this.partMembers(r.to.slice(0, r.to.lastIndexOf(".")));
    return new Set([...own].filter((a) => from.has(a) && to.has(a)));
  }

  /**
   * What `a` is marked against: the previous phase (a first phase against
   * itself, so unmarked), otherwise the baseline.
   */
  against(a: ArrangementName): ArrangementName {
    const { names, baseline, phased } = this.plan;
    if (!phased) return baseline;
    const i = names.indexOf(a);
    return i > 0 ? names[i - 1] : a;
  }

  /** Phased: the phase story beat `b` runs in; otherwise undefined. */
  phaseOf(b: number): ArrangementName | undefined {
    return this.plan.phased ? this.plan.beatPhases[b] : undefined;
  }

  /** Named: the arrangements a step runs in — its own, where its part and rail are. */
  stepMembers(s: StepSpec): ReadonlySet<string> {
    const part = this.partMembers(s.part);
    const rail = s.via ? this.railMembers(s.via) : undefined;
    return new Set(
      [...this.all(s.in)].filter((a) => part.has(a) && (rail?.has(a) ?? true))
    );
  }

  part(p: PartSpec, a: ArrangementName): PartReading {
    const { named } = this.plan;
    const baseline = this.against(a);
    if (!named) {
      const override =
        a === "before" ? p.before : a === "after" ? p.after : undefined;
      const changeNote = override?.changeNote ?? p.changeNote;
      return {
        presence: shorthandPresence(p.change, a),
        change: a === "before" ? "unchanged" : (p.change ?? "unchanged"),
        ...(changeNote && a !== "before" ? { changeNote } : {}),
        ...(override ? { override } : {}),
        portChanges: a === "before" ? {} : only(p.portChanges),
        stageChanges: a === "before" ? {} : only(p.stageChanges),
      };
    }
    const members = this.partMembers(p.id);
    const override = p.arrangement && own(p.arrangement, a);
    const presence = presenceIn(members, a, baseline);
    const membership = markIn(members, a, baseline);
    const change: ChangeMark =
      membership !== "unchanged" || a === baseline || presence !== "live"
        ? membership
        : this.overridesDiffer(p, a)
          ? "changed"
          : "unchanged";
    const changeNote =
      change === "unchanged"
        ? undefined
        : (override?.changeNote ?? p.changeNote);
    const inner = a === baseline || presence !== "live";
    return {
      presence,
      change,
      ...(changeNote ? { changeNote } : {}),
      ...(override ? { override } : {}),
      portChanges: inner ? {} : only(override?.portChanges),
      stageChanges: inner ? {} : only(override?.stageChanges),
    };
  }

  /** Named: whether a part in both `a` and what it is marked against reads differently. */
  private overridesDiffer(p: PartSpec, a: ArrangementName): boolean {
    const mine = p.arrangement && own(p.arrangement, a);
    const base = p.arrangement && own(p.arrangement, this.against(a));
    return (
      mine?.changeNote !== base?.changeNote ||
      JSON.stringify(this.props(p, mine)) !==
        JSON.stringify(this.props(p, base))
    );
  }

  /** A rail; `ends` is the presence of its from and to parts in `a`. */
  rail(
    r: RailSpec,
    a: ArrangementName,
    ends: readonly [Presence, Presence]
  ): RailReading {
    const { named } = this.plan;
    const baseline = this.against(a);
    if (!named) {
      const own = shorthandPresence(r.change, a);
      return {
        presence:
          own !== "live" ? own : (ends.find((e) => e !== "live") ?? "live"),
        change: a === "before" ? "unchanged" : (r.change ?? "unchanged"),
      };
    }
    const members = this.railMembers(r.id);
    return {
      presence: presenceIn(members, a, baseline),
      change: markIn(members, a, baseline),
    };
  }

  /**
   * Whether a step runs in `a`. A shorthand step also needs its part and
   * rail live there, which the compiler checks as it goes.
   */
  runs(s: StepSpec, a: ArrangementName): boolean {
    return this.plan.named ? this.stepMembers(s).has(a) : stepRuns(s.change, a);
  }

  /** The mark a step's beat lists in `a`; none in the baseline (or a first phase). */
  stepMark(s: StepSpec, a: ArrangementName): ChangeMark {
    const { named } = this.plan;
    const baseline = this.against(a);
    if (a === baseline) return "unchanged";
    return named
      ? markIn(this.stepMembers(s), a, baseline)
      : (s.change ?? "unchanged");
  }

  caption(c: Caption | undefined, a: ArrangementName): string | undefined {
    if (c === undefined || typeof c === "string") return c;
    // The shorthand's lone `current` reads the After side.
    if (!this.plan.named && a === "current") return c.after ?? c.before;
    return own(c, a);
  }
}

/**
 * The value of a per-arrangement field: one value for every arrangement, or
 * a map by name (validated to give every arrangement). The shorthand's
 * `current` reads the After side.
 */
export function valueIn<T>(
  v: T | Readonly<Record<string, T>> | undefined,
  a: ArrangementName
): T | undefined {
  if (typeof v !== "object" || v === null || Array.isArray(v))
    return v as T | undefined;
  const byName = v as Readonly<Record<string, T>>;
  return own(byName, a) ?? (a === "current" ? own(byName, "after") : undefined);
}
