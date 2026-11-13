/**
 * Property and oracle tests of named arrangements. Hegel generates machines
 * whose parts, rails and steps are each in some of 1–4 named arrangements,
 * with per-arrangement props, captions and band chips, and checks:
 *
 * - marks follow presence: what each arrangement draws is computed from
 *   membership against the baseline, by an independent model;
 * - one layout: parts, rails and the band keep their geometry in every
 *   arrangement;
 * - independence: dropping or reordering the other arrangements leaves an
 *   arrangement's timeline unchanged (metamorphic);
 * - the Before/After shorthand is the oracle for two named arrangements: a
 *   consistently marked shorthand spec and its `arrangements: [before,
 *   after]` translation compile to the same timelines.
 */
import { test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import {
  compileFlow,
  formatFlowError,
  type Caption,
  type CompiledFlow,
  type DiagramTimeline,
  type FlowSpec,
  type PartSpec,
  type RailSpec,
  type StepSpec,
} from "./index";
import {
  KINDS,
  NOTES,
  RAILS,
  world,
  type Kind,
  type World,
} from "./arrangementWorlds";

function check(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

function compiled(spec: FlowSpec): CompiledFlow {
  const r = compileFlow(spec);
  if (!r.ok)
    throw new Error(
      `${r.errors.map(formatFlowError).join("\n")}\n${JSON.stringify(spec)}`
    );
  return r.flow;
}

const json = (v: unknown) => JSON.stringify(v);

/** Presence and mark of something present in `members`, read in `a`. */
function expected(members: ReadonlySet<string>, a: string, base: string) {
  const presence = members.has(a)
    ? "live"
    : members.has(base)
      ? "removed"
      : "absent";
  const change =
    a === base || members.has(a) === members.has(base)
      ? "unchanged"
      : members.has(a)
        ? "added"
        : "removed";
  return { presence, change };
}

const SETTINGS = { testCases: 200 };

test("marks follow presence against the baseline", () =>
  hegel.test((tc) => {
    const w = tc.draw(world);
    const flow = compiled(w.spec);
    check(
      json(flow.arrangements.map((d) => d.arrangement)) === json(w.names),
      "arrangements are not in spec order"
    );
    check(flow.baseline === w.baseline, `baseline is ${flow.baseline}`);
    for (const d of flow.arrangements) {
      const a = d.arrangement;
      for (const p of d.parts) {
        const members = w.parts.get(p.id)!;
        const want = expected(members, a, w.baseline);
        const read = w.reads.get(p.id)!;
        const mine = read.get(a);
        const base = read.get(w.baseline);
        const changed =
          want.change === "unchanged" &&
          a !== w.baseline &&
          members.has(a) &&
          members.has(w.baseline) &&
          (json(mine?.value) !== json(base?.value) ||
            mine?.note !== base?.note);
        const change = changed ? "changed" : want.change;
        check(
          p.presence === want.presence && p.change === change,
          `${a}: part ${p.id} is ${p.presence}/${p.change}, expected ${want.presence}/${change}`
        );
        const spec = w.spec.parts.find((s) => s.id === p.id)!;
        const note =
          change === "unchanged" ? undefined : (mine?.note ?? spec.changeNote);
        check(
          p.changeNote === note,
          `${a}: part ${p.id} notes ${p.changeNote}, expected ${note}`
        );
        if (a === w.baseline)
          check(
            json(p.portChanges) === "{}" && p.stageMarks.length === 0,
            `the baseline marks ports or stages of ${p.id}`
          );
      }
      for (const r of d.rails) {
        const want = expected(w.rails.get(r.id)!, a, w.baseline);
        check(
          r.presence === want.presence && r.change === want.change,
          `${a}: rail ${r.id} is ${r.presence}/${r.change}, expected ${want.presence}/${want.change}`
        );
      }
      // Steps run exactly where they are present; beats list them against the baseline.
      const ran = new Map<string, number>();
      const listed: string[] = [];
      (w.spec.story ?? []).forEach((beat, b) =>
        (beat.steps ?? []).forEach((s, k) => {
          const members = w.steps.get(`${b}:${k}`)!;
          if (members.has(a)) ran.set(s.part, (ran.get(s.part) ?? 0) + 1);
          const { change } = expected(members, a, w.baseline);
          if (change !== "unchanged")
            listed.push(`${change} ${s.part}.${s.verb}`);
        })
      );
      for (const p of d.parts)
        check(
          p.steps.length === (ran.get(p.id) ?? 0),
          `${a}: part ${p.id} ran ${p.steps.length} steps, expected ${ran.get(p.id) ?? 0}`
        );
      const marks = d.beats.flatMap((beat) =>
        beat.changes.map((c) => `${c.change} ${c.part}.${c.verb}`)
      );
      // Uncaptioned beats fold into the previous one, or drop before the first.
      check(
        marks.every((m) => listed.includes(m)) &&
          (d.beats.length === 0 || marks.length <= listed.length),
        `${a}: beats list ${json(marks)}, the model ${json(listed)}`
      );
      if (a === w.baseline)
        check(marks.length === 0, "the baseline lists marked steps");
      check(
        flow.labels[a] ===
          (json(w.spec.arrangements).includes('"label"')
            ? `Option ${a}`
            : a === "current"
              ? "Current"
              : a),
        `${a} is labelled ${flow.labels[a]}`
      );
    }
  }, SETTINGS));

test("every arrangement shares one layout and one band geometry", () =>
  hegel.test((tc) => {
    const w = tc.draw(world);
    const flow = compiled(w.spec);
    const geometry = (d: DiagramTimeline) =>
      json({
        size: [d.width, d.height],
        parts: d.parts.map((p) => [p.id, p.position, p.scale, p.ports]),
        rails: d.rails.map((r) => [r.id, r.points, r.labelAt]),
        regions: d.regions,
        band: d.band && {
          ...d.band,
          rows: d.band.rows.map((r) => r.y),
          meter: d.band.meter && { ...d.band.meter, times: [], footnote: "" },
        },
      });
    const first = geometry(flow.arrangements[0]);
    for (const d of flow.arrangements)
      check(
        geometry(d) === first,
        `${d.arrangement} is laid out differently from ${flow.arrangements[0].arrangement}`
      );
  }, SETTINGS));

/** What an arrangement draws and runs, without the shared geometry. */
function reading(d: DiagramTimeline) {
  return json({
    period: d.period,
    parts: d.parts.map((p) => ({
      ...p,
      position: undefined,
      ports: undefined,
    })),
    rails: d.rails.map((r) => ({
      ...r,
      points: undefined,
      labelAt: undefined,
    })),
    beats: d.beats,
    markers: d.markers,
    counts: d.counts,
    windows: d.beatWindows,
    band: d.band?.rows.map((r) => [
      r.note,
      r.chips.map((c) => c.text),
      r.windows,
    ]),
    meter: d.band?.meter?.times,
  });
}

/**
 * The world's spec without arrangement `x`: dropped from every list, and the
 * parts, rails and steps present only there dropped too.
 */
function without(w: World, x: string): FlowSpec {
  const spec = w.spec;
  const keep = (list?: readonly string[]) => list?.filter((a) => a !== x);
  const only = (m: ReadonlySet<string>) => m.size === 1 && m.has(x);
  const gone = new Set(
    spec.parts.filter((p) => only(w.parts.get(p.id)!)).map((p) => p.id)
  );
  const drop = <T extends object>(o: T | undefined) =>
    o && Object.fromEntries(Object.entries(o).filter(([k]) => k !== x));
  return {
    ...spec,
    arrangements: spec.arrangements!.filter(
      (d) => (typeof d === "string" ? d : d.name) !== x
    ),
    parts: spec.parts
      .filter((p) => !gone.has(p.id))
      .map((p) => ({
        ...p,
        ...(p.in ? { in: keep(p.in) } : {}),
        ...(p.arrangement ? { arrangement: drop(p.arrangement) } : {}),
      })),
    rails: (spec.rails ?? [])
      .filter((r) => !only(w.rails.get(r.id)!))
      .map((r) => (r.in ? { ...r, in: keep(r.in) } : r)),
    story: (spec.story ?? []).map((b, i) => ({
      ...b,
      ...(typeof b.caption === "object" ? { caption: drop(b.caption) } : {}),
      steps: (b.steps ?? [])
        .filter((_, k) => !only(w.steps.get(`${i}:${k}`)!))
        .map((s) => (s.in ? { ...s, in: keep(s.in) } : s)),
    })),
    ...(spec.band
      ? {
          band: {
            ...spec.band,
            rows: spec.band.rows.map((r) => ({
              ...r,
              chips: Array.isArray(r.chips) ? r.chips : drop(r.chips)!,
            })),
          },
        }
      : {}),
  };
}

test("dropping one arrangement leaves every other one as it was", () =>
  hegel.test((tc) => {
    const w = tc.draw(world);
    const others = w.names.filter((a) => a !== w.baseline);
    tc.assume(others.length > 0);
    const x = tc.draw(gs.sampledFrom(others));
    const reduced = without(w, x);
    tc.assume(reduced.parts.length > 0);
    const all = compiled(w.spec);
    const fewer = compiled({ ...reduced, baseline: w.baseline });
    for (const d of fewer.arrangements) {
      const before = all.arrangements.find(
        (e) => e.arrangement === d.arrangement
      )!;
      // Parts only in `x` were dropped; compare the ones still there.
      const ids = new Set(d.parts.map((p) => p.id));
      const narrowed = {
        ...before,
        parts: before.parts.filter((p) => ids.has(p.id)),
        rails: before.rails.filter((r) => d.rails.some((q) => q.id === r.id)),
      };
      check(
        reading(narrowed) === reading(d),
        `dropping ${x} changed ${d.arrangement}`
      );
    }
  }, SETTINGS));

test("reordering the other arrangements reorders the timelines and nothing else", () =>
  hegel.test((tc) => {
    const w = tc.draw(world);
    const order = [...w.spec.arrangements!];
    for (let i = order.length - 1; i > 0; i--) {
      const j = tc.draw(gs.integers({ minValue: 0, maxValue: i }));
      [order[i], order[j]] = [order[j], order[i]];
    }
    const a = compiled({ ...w.spec, baseline: w.baseline });
    const b = compiled({
      ...w.spec,
      arrangements: order,
      baseline: w.baseline,
    });
    const byName = (f: CompiledFlow) =>
      new Map(
        f.arrangements.map((d) => [
          d.arrangement,
          json({
            ...d,
            band: d.band && {
              ...d.band,
              meter: d.band.meter && { ...d.band.meter, footnote: "" },
            },
          }),
        ])
      );
    const [x, y] = [byName(a), byName(b)];
    for (const [name, d] of x)
      check(y.get(name) === d, `reordering changed ${name}`);
  }, SETTINGS));

/* ---------- the shorthand as the oracle for [before, after] ---------- */

type Side = "both" | "before" | "after";
const SIDES: Readonly<Record<Side, readonly string[]>> = {
  both: ["before", "after"],
  before: ["before"],
  after: ["after"],
};

/**
 * A consistently marked Before/After spec and its named translation: every
 * part, rail and step is in both, only Before or only After, and the
 * shorthand marks exactly that (a rail or step on an added part is added).
 */
const pair = gs.composite<{ shorthand: FlowSpec; named: FlowSpec }>((tc) => {
  const n = tc.draw(gs.integers({ minValue: 1, maxValue: 6 }));
  const sides: Side[] = [];
  const kinds: Kind[] = [];
  const short: PartSpec[] = [];
  const named: PartSpec[] = [];
  for (let i = 0; i < n; i++) {
    const k = tc.draw(gs.sampledFrom(KINDS));
    const side = tc.draw(
      gs.sampledFrom(["both", "both", "before", "after"] as const)
    );
    const changed =
      side === "both" && k.prop !== undefined && tc.draw(gs.booleans());
    const note =
      side !== "both" || changed ? tc.draw(gs.sampledFrom(NOTES)) : undefined;
    const port =
      side === "both" && k.kind === "queue" && tc.draw(gs.booleans());
    const id = `p${i}`;
    kinds.push(k);
    sides.push(side);
    const props = changed
      ? { before: { [k.prop!]: 1 }, after: { [k.prop!]: 2 } }
      : undefined;
    short.push({
      id,
      kind: k.kind,
      ...(side === "after" ? { change: "added" } : {}),
      ...(side === "before" ? { change: "removed" } : {}),
      ...(changed ? { change: "changed" } : {}),
      ...(note ? { changeNote: note } : {}),
      ...(props
        ? { before: { props: props.before }, after: { props: props.after } }
        : {}),
      ...(port ? { portChanges: { dead: "added" } } : {}),
    });
    named.push({
      id,
      kind: k.kind,
      ...(side !== "both" ? { in: SIDES[side] } : {}),
      ...(note ? { changeNote: note } : {}),
      ...(props || port
        ? {
            arrangement: {
              ...(props ? { before: { props: props.before } } : {}),
              after: {
                ...(props ? { props: props.after } : {}),
                ...(port ? { portChanges: { dead: "added" as const } } : {}),
              },
            },
          }
        : {}),
    });
  }
  const meet = (a: Side, b: Side): Side | undefined =>
    a === "both" ? b : b === "both" || b === a ? a : undefined;
  const mark = (s: Side) =>
    s === "after"
      ? ("added" as const)
      : s === "before"
        ? ("removed" as const)
        : undefined;

  const shortRails: RailSpec[] = [];
  const namedRails: RailSpec[] = [];
  kinds.forEach((a, i) =>
    kinds.forEach((b, j) => {
      for (const [from, kind, to] of RAILS[a.kind]) {
        if (kind !== b.kind || i === j || !tc.draw(gs.booleans())) continue;
        const ends = meet(sides[i], sides[j]);
        if (!ends) continue;
        // A rail between two parts in both may itself be only on one side.
        const side =
          ends === "both"
            ? tc.draw(
                gs.sampledFrom(["both", "both", "before", "after"] as const)
              )
            : ends;
        const id = `r${shortRails.length}`;
        const base = { id, from: `p${i}.${from}`, to: `p${j}.${to}` };
        const m = mark(side);
        shortRails.push({ ...base, ...(m ? { change: m } : {}) });
        namedRails.push({
          ...base,
          ...(side !== ends ? { in: SIDES[side] } : {}),
        });
      }
    })
  );

  const beats = tc.draw(gs.integers({ minValue: 1, maxValue: 4 }));
  const shortStory = [];
  const namedStory = [];
  for (let b = 0; b < beats; b++) {
    const s: StepSpec[] = [];
    const t: StepSpec[] = [];
    const m = tc.draw(gs.integers({ minValue: 0, maxValue: 3 }));
    for (let k = 0; k < m; k++) {
      const i = tc.draw(gs.integers({ minValue: 0, maxValue: n - 1 }));
      const verb = tc.draw(gs.sampledFrom(kinds[i].verbs));
      const side =
        sides[i] === "both"
          ? tc.draw(
              gs.sampledFrom(["both", "both", "before", "after"] as const)
            )
          : sides[i];
      const changed =
        side === "both" &&
        tc.draw(gs.integers({ minValue: 0, maxValue: 3 })) === 0;
      const m2 = mark(side);
      s.push({
        verb,
        part: `p${i}`,
        ...(m2 ? { change: m2 } : changed ? { change: "changed" } : {}),
      });
      t.push({
        verb,
        part: `p${i}`,
        ...(side !== sides[i] ? { in: SIDES[side] } : {}),
      });
    }
    const caption = tc.draw(
      gs.sampledFrom<Caption>([
        `beat ${b}`,
        { before: `before ${b}`, after: `after ${b}` },
        { after: `after only ${b}` },
        { before: `before only ${b}` },
      ])
    );
    shortStory.push({ id: `b${b}`, caption, steps: s });
    namedStory.push({ id: `b${b}`, caption, steps: t });
  }
  // A step marked changed is listed in After; named arrangements only list
  // presence, so only compare specs without one.
  tc.assume(
    !shortStory.some((b) => b.steps.some((s) => s.change === "changed"))
  );
  const band = {
    rows: [
      {
        name: "row",
        beats: shortStory.map((b) => b.id),
        note: { before: "old", after: "new" },
        chips: { before: ["a"], after: ["b", "c"] },
      },
    ],
    meter: { label: "ticks", marker: "tick" },
  };
  return {
    shorthand: {
      version: 1,
      parts: short,
      rails: shortRails,
      story: shortStory,
      band,
    },
    named: {
      version: 1,
      arrangements: ["before", "after"],
      parts: named,
      rails: namedRails,
      story: namedStory,
      band,
    },
  };
});

test("two named arrangements compile exactly as the Before/After shorthand", () =>
  hegel.test((tc) => {
    const { shorthand, named } = tc.draw(pair);
    const oracle = compiled(shorthand);
    const flow = compiled(named);
    // A spec with nothing marked is one `current` arrangement in the shorthand.
    tc.assume(oracle.arrangements.length === 2);
    check(
      json(flow.arrangements) === json(oracle.arrangements),
      `named [before, after] differs from the shorthand\n${json(shorthand)}`
    );
    check(
      json([flow.baseline, flow.labels]) ===
        json([oracle.baseline, oracle.labels]),
      "baseline or labels differ"
    );
  }, SETTINGS));
