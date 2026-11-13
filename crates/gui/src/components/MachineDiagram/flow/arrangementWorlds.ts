/**
 * Hegel generator of named-arrangement specs shared by the property, oracle
 * and rejection tests: machines whose parts, rails and steps are each in
 * some of 1–4 named arrangements, with per-arrangement props, captions and
 * band chips, plus the model of where everything is.
 */
import type * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import type { FlowSpec, PartSpec, RailSpec, StepSpec } from "./index";

/**
 * Part kinds with a number prop, their card-free verbs (so any step is valid
 * wherever its part is), and ports for rails.
 */
export const KINDS = [
  { kind: "queue", prop: "slots", verbs: ["wait"] },
  { kind: "store", prop: "rows", verbs: ["delete", "snapshot"] },
  { kind: "rate limiter", prop: "tokens", verbs: ["wait", "refill"] },
  { kind: "source", prop: undefined, verbs: ["tick", "spawn", "observe"] },
  { kind: "worker", prop: undefined, verbs: ["fail"] },
] as const;
export type Kind = (typeof KINDS)[number];
/** Rails a spec can draw between two kinds. */
export const RAILS: Readonly<
  Record<string, readonly [string, string, string][]>
> = {
  source: [
    ["out", "queue", "in"],
    ["out", "store", "in"],
    ["out", "worker", "in"],
  ],
  queue: [
    ["out", "worker", "in"],
    ["dead", "store", "in"],
    ["out", "store", "in"],
  ],
  "rate limiter": [["out", "queue", "in"]],
  worker: [],
  store: [],
};
export const NOTES = ["now buffered", "sheds load", "journals jobs"] as const;
export const CHIPS = ["queue", "shed", "retry", "journal", "wait"] as const;

export interface World {
  readonly spec: FlowSpec;
  readonly names: readonly string[];
  readonly baseline: string;
  /** The model: where each part, rail and step is present. */
  readonly parts: ReadonlyMap<string, ReadonlySet<string>>;
  readonly rails: ReadonlyMap<string, ReadonlySet<string>>;
  /** By `beat:step`. */
  readonly steps: ReadonlyMap<string, ReadonlySet<string>>;
  /** Resolved prop value and note per part and arrangement (undefined: none). */
  readonly reads: ReadonlyMap<
    string,
    ReadonlyMap<string, { value: unknown; note?: string }>
  >;
}

/** A non-empty subset of `of`, drawn element by element. */
export function subset(tc: hegel.TestCase, of: readonly string[]): string[] {
  const out = of.filter(() => tc.draw(gs.booleans()));
  return out.length > 0 ? out : [tc.draw(gs.sampledFrom(of))];
}

export const inter = (a: ReadonlySet<string>, b: ReadonlySet<string>) =>
  new Set([...a].filter((x) => b.has(x)));

/** A named spec over 1–4 arrangements and the model of where everything is. */
export const world = gs.composite<World>((tc) => {
  const count = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
  const names = ["current", "A", "B", "C"].slice(0, count);
  const baseline = tc.draw(gs.sampledFrom(names));
  const explicitBaseline = baseline !== names[0] || tc.draw(gs.booleans());
  const labelled = tc.draw(gs.booleans());

  const n = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  const kinds: Kind[] = [];
  const parts: PartSpec[] = [];
  const partIn = new Map<string, ReadonlySet<string>>();
  const reads = new Map<
    string,
    Map<string, { value: unknown; note?: string }>
  >();
  for (let i = 0; i < n; i++) {
    const k = tc.draw(gs.sampledFrom(KINDS));
    const id = `p${i}`;
    const everywhere = tc.draw(gs.booleans());
    const members = everywhere ? names : subset(tc, names);
    const note = tc.draw(gs.booleans())
      ? tc.draw(gs.sampledFrom(NOTES))
      : undefined;
    const arrangement: Record<
      string,
      { props?: Record<string, unknown>; changeNote?: string }
    > = {};
    const read = new Map<string, { value: unknown; note?: string }>();
    for (const a of members) {
      const value =
        k.prop && tc.draw(gs.booleans())
          ? tc.draw(gs.integers({ minValue: 1, maxValue: 3 }))
          : undefined;
      const own = tc.draw(gs.integers({ minValue: 0, maxValue: 4 })) === 0;
      const changeNote = own ? tc.draw(gs.sampledFrom(NOTES)) : undefined;
      if (value !== undefined || changeNote !== undefined)
        arrangement[a] = {
          ...(value !== undefined ? { props: { [k.prop!]: value } } : {}),
          ...(changeNote !== undefined ? { changeNote } : {}),
        };
      read.set(a, { value, ...(changeNote ? { note: changeNote } : {}) });
    }
    kinds.push(k);
    partIn.set(id, new Set(members));
    reads.set(id, read);
    parts.push({
      id,
      kind: k.kind,
      ...(everywhere ? {} : { in: members }),
      ...(note ? { changeNote: note } : {}),
      ...(Object.keys(arrangement).length ? { arrangement } : {}),
    });
  }

  // Rails between parts that share an arrangement.
  const rails: RailSpec[] = [];
  const railIn = new Map<string, ReadonlySet<string>>();
  kinds.forEach((a, i) =>
    kinds.forEach((b, j) => {
      for (const [from, kind, to] of RAILS[a.kind])
        if (kind === b.kind && i !== j && tc.draw(gs.booleans())) {
          const shared = inter(partIn.get(`p${i}`)!, partIn.get(`p${j}`)!);
          if (shared.size === 0) continue;
          const own = tc.draw(gs.booleans())
            ? subset(tc, [...shared])
            : undefined;
          const id = `r${rails.length}`;
          rails.push({
            id,
            from: `p${i}.${from}`,
            to: `p${j}.${to}`,
            ...(own ? { in: own } : {}),
          });
          railIn.set(id, own ? new Set(own) : shared);
        }
    })
  );

  // Card-free steps on parts, some listed in fewer arrangements.
  const stepIn = new Map<string, ReadonlySet<string>>();
  const beats = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
  const story = Array.from({ length: beats }, (_, b) => {
    const steps: StepSpec[] = [];
    const m = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    for (let k = 0; k < m; k++) {
      const i = tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }));
      const verb = tc.draw(gs.sampledFrom(kinds[i].verbs));
      const members = partIn.get(`p${i}`)!;
      const own = tc.draw(gs.booleans()) ? subset(tc, [...members]) : undefined;
      steps.push({
        verb,
        part: `p${i}`,
        ...(own ? { in: own } : {}),
        ...(k > 0 && tc.draw(gs.booleans()) ? { with: true } : {}),
      });
      stepIn.set(`${b}:${k}`, own ? new Set(own) : members);
    }
    const keyed = tc.draw(gs.booleans());
    const caption = keyed
      ? Object.fromEntries(
          names
            .filter(() => tc.draw(gs.booleans()))
            .map((a) => [a, `beat ${b} in ${a}`])
        )
      : `beat ${b}`;
    return { id: `b${b}`, caption, steps };
  });

  const band = tc.draw(gs.booleans())
    ? {
        rows: [
          {
            name: "row",
            beats: story.map((s) => s.id),
            chips: tc.draw(gs.booleans())
              ? Object.fromEntries(
                  names.map((a) => [
                    a,
                    tc.draw(
                      gs.arrays(gs.sampledFrom(CHIPS), {
                        minSize: 1,
                        maxSize: 3,
                      })
                    ),
                  ])
                )
              : ["shared"],
          },
        ],
        meter: { label: "spawns", marker: ["spawn", "tick"] },
      }
    : undefined;

  const spec: FlowSpec = {
    version: 1,
    arrangements: names.map((a) =>
      labelled ? { name: a, label: `Option ${a}` } : a
    ),
    ...(explicitBaseline ? { baseline } : {}),
    parts,
    rails,
    story,
    ...(band ? { band } : {}),
  };
  return {
    spec,
    names,
    baseline,
    parts: partIn,
    rails: railIn,
    steps: stepIn,
    reads,
  };
});
