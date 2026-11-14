/**
 * Phases: a migration told by the story. Each beat is in a phase (the last
 * one a beat at or before it started), each phase is marked against the
 * phase before it, and every phase's timeline replays the whole story so
 * cards are where the story left them when a phase begins.
 */
import { describe, expect, it, test } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import sessionMigration from "./__fixtures__/sessionMigration.flow.yaml?raw";
import { planOf } from "./arrangements";
import {
  arrangement,
  compileFlow,
  compileFlowOrThrow,
  formatFlowError,
  parseFlowSpec,
  type DiagramTimeline,
  type FlowSpec,
} from "./index";
import {
  beatOutcome,
  beatStart,
  initialClock,
  retarget,
  shownBeat,
} from "./clockModel";

function load(text: string): FlowSpec {
  const r = parseFlowSpec(text);
  if (!r.ok) throw new Error(r.errors.map(formatFlowError).join("\n"));
  return r.value as FlowSpec;
}

function errorsOf(input: unknown): string[] {
  const r = compileFlow(input);
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors.map(formatFlowError);
}

const marks = (d: DiagramTimeline) =>
  Object.fromEntries(d.parts.map((p) => [p.id, `${p.presence}/${p.change}`]));
const railMarks = (d: DiagramTimeline) =>
  Object.fromEntries(d.rails.map((r) => [r.id, `${r.presence}/${r.change}`]));

/**
 * today: src → old → w. p1 adds x beside old; p2 retires old; target
 * changes x. One card per phase, and `c0` crosses phases.
 */
const migration = (): FlowSpec => ({
  version: 1,
  phases: ["today", "p1", "p2", { name: "target", label: "Target" }],
  parts: [
    { id: "src", kind: "source" },
    { id: "old", kind: "queue", in: ["today", "p1"] },
    {
      id: "x",
      kind: "queue",
      in: ["p1", "p2", "target"],
      arrangement: { target: { props: { slots: 4 }, changeNote: "wider" } },
    },
    { id: "w", kind: "worker" },
  ],
  rails: [
    { id: "so", from: "src.out", to: "old.in" },
    { id: "ow", from: "old.out", to: "w.in" },
    { id: "sx", from: "src.out", to: "x.in" },
    { id: "xw", from: "x.out", to: "w.in" },
  ],
  cards: [
    { id: "c0", token: "request", origin: "src" },
    { id: "c1", token: "request", origin: "src" },
    { id: "c2", token: "request", origin: "src" },
  ],
  story: [
    {
      id: "a",
      caption: "today: through the old queue",
      steps: [
        { verb: "send", part: "old", card: "c0", via: "so" },
        { verb: "drain", part: "old", card: "c0" },
        { verb: "stage", part: "w", card: "c0", via: "ow" },
      ],
    },
    {
      id: "b",
      phase: "p1",
      caption: "p1: the new queue beside it",
      steps: [
        { verb: "finish", part: "w", card: "c0" },
        { verb: "send", part: "x", card: "c1", via: "sx" },
      ],
    },
    { id: "b2", caption: "p1 again", steps: [] },
    {
      id: "c",
      phase: "p2",
      caption: "p2: the old queue is gone",
      steps: [
        { verb: "drain", part: "x", card: "c1" },
        { verb: "stage", part: "w", card: "c1", via: "xw" },
      ],
    },
    {
      id: "d",
      phase: "target",
      caption: "target: a wider queue",
      steps: [{ verb: "send", part: "x", card: "c2", via: "sx" }],
    },
  ],
});

describe("phases compile", () => {
  const flow = compileFlowOrThrow(migration());
  const at = (a: string) => arrangement(flow, a)!;

  it("compiles one timeline per phase, in order, starting from the first", () => {
    expect(flow.phased).toBe(true);
    expect(flow.arrangements.map((d) => d.arrangement)).toEqual([
      "today",
      "p1",
      "p2",
      "target",
    ]);
    expect(flow.baseline).toBe("today");
    expect(flow.labels).toMatchObject({ today: "today", target: "Target" });
  });

  it("resolves each beat to the phase it is in, the same in every phase", () => {
    expect(planOf(migration()).beatPhases).toEqual([
      "today",
      "p1",
      "p1",
      "p2",
      "target",
    ]);
    for (const d of flow.arrangements)
      expect(d.beats.map((b) => [b.story, b.phase, b.caption])).toEqual(
        at("today").beats.map((b) => [b.story, b.phase, b.caption])
      );
  });

  it("marks each phase against the one before it", () => {
    // Added in p1: absent before, marked added only in p1, unchanged after.
    expect(marks(at("today")).x).toBe("absent/unchanged");
    expect(marks(at("p1")).x).toBe("live/added");
    expect(marks(at("p2")).x).toBe("live/unchanged");
    // Its override in target differs from p2's reading: changed there.
    expect(marks(at("target")).x).toBe("live/changed");
    expect(at("target").parts.find((p) => p.id === "x")!.changeNote).toBe(
      "wider"
    );
    // Removed in p2: present until p2, ghosted and marked removed there, then gone.
    expect(marks(at("today")).old).toBe("live/unchanged");
    expect(marks(at("p1")).old).toBe("live/unchanged");
    expect(marks(at("p2")).old).toBe("removed/removed");
    expect(marks(at("target")).old).toBe("absent/unchanged");
    // Rails follow their parts.
    expect(railMarks(at("today"))).toMatchObject({
      so: "live/unchanged",
      sx: "absent/unchanged",
    });
    expect(railMarks(at("p1"))).toMatchObject({
      so: "live/unchanged",
      sx: "live/added",
      xw: "live/added",
    });
    expect(railMarks(at("p2"))).toMatchObject({
      so: "removed/removed",
      ow: "removed/removed",
      sx: "live/unchanged",
    });
    expect(railMarks(at("target"))).toMatchObject({
      so: "absent/unchanged",
      sx: "live/unchanged",
    });
    // The first phase draws no marks.
    expect(at("today").parts.every((p) => p.change === "unchanged")).toBe(true);
  });

  it("lists a beat's step marks against the phase before the beat's", () => {
    const changes = (story: number) =>
      at("today")
        .beats.find((b) => b.story === story)!
        .changes.map((c) => `${c.change} ${c.part}.${c.verb}`);
    expect(changes(0)).toEqual([]);
    // c1 travels the new rail into the new queue: added in p1.
    expect(changes(1)).toEqual(["added x.send"]);
    // In p2 the new path is unchanged from p1.
    expect(changes(3)).toEqual([]);
  });

  it("replays earlier phases' beats in every phase, so cards carry over", () => {
    for (const d of flow.arrangements) {
      const w = d.parts.find((p) => p.id === "w")!;
      // c0 was staged in today and finishes in p1, whichever phase draws it.
      expect(w.steps.map((s) => `${s.verb}:${s.card?.id}`)).toEqual([
        "stage:c0",
        "finish:c0",
        "stage:c1",
      ]);
      // Beats start at the same time in every phase.
      expect(d.beats.map((b) => b.t)).toEqual(
        at("today").beats.map((b) => b.t)
      );
    }
  });

  it("the reference migration compiles with at least three phases", () => {
    const ref = compileFlowOrThrow(load(sessionMigration));
    expect(ref.phased).toBe(true);
    expect(ref.arrangements.length).toBeGreaterThanOrEqual(3);
    const phases = ref.arrangements.map((d) => d.arrangement);
    expect([...new Set(ref.arrangements[0].beats.map((b) => b.phase))]).toEqual(
      phases
    );
    // One process count for the story, not one footnote per phase.
    expect(ref.arrangements[0].band?.meter?.footnote).toBeUndefined();
  });
});

describe("phases validate", () => {
  const withStory = (story: FlowSpec["story"]): FlowSpec => ({
    ...migration(),
    story,
  });

  it("rejects phases beside arrangements or a baseline", () => {
    expect(
      errorsOf({ ...migration(), arrangements: ["today", "p1"] })
    ).toContain(
      "phases: give either arrangements (the reader picks one) or phases (the story moves through them), not both"
    );
    expect(errorsOf({ ...migration(), baseline: "p1" })).toEqual([
      "baseline: phases are marked against the phase before them; the first phase has no marks, so there is no baseline to name",
    ]);
  });

  it("needs phases started in order, each by one captioned beat", () => {
    const beat = (phase?: string, caption: string | null = "x") => ({
      ...(phase ? { phase } : {}),
      ...(caption !== null ? { caption } : {}),
      steps: [{ verb: "send" as const, part: "src", card: "c0" }],
    });
    expect(errorsOf(withStory([beat(), beat("p2"), beat("target")]))).toEqual([
      'story[1].phase: skips phase "p1"; phases run in order (today → p1 → p2 → target), each started by one beat',
    ]);
    expect(
      errorsOf(
        withStory([beat(), beat("p1"), beat("p1"), beat("p2"), beat("target")])
      )
    ).toEqual([
      'story[2].phase: phase "p1" has already started; phases run in order (today → p1 → p2 → target), each started by one beat',
    ]);
    expect(errorsOf(withStory([beat(), beat("p1"), beat("p2")]))).toEqual([
      'phases: phase "target" never starts: give the beat that starts it phase: target',
    ]);
    expect(errorsOf(withStory([]))).toEqual([
      'phases: phase "p1" never starts: give the beat that starts it phase: p1',
    ]);
    expect(
      errorsOf(withStory([beat("p1"), beat("p2"), beat("target")]))
    ).toContain(
      'story[0].phase: the story starts in the first phase "today"; start "p1" at a later beat'
    );
    expect(
      errorsOf(
        withStory([beat(), beat("p1", null), beat("p2"), beat("target")])
      )
    ).toEqual([
      'story[1].caption: is required: the beat starts phase "p1", and the phase strip lands on it',
    ]);
    expect(
      errorsOf(withStory([beat(), beat("p9"), beat("p2"), beat("target")]))
    ).toContainEqual(
      expect.stringMatching(/^story\[1\]\.phase: unknown phase "p9" /)
    );
    // The first phase may be named on the first beat.
    expect(
      compileFlow(
        withStory([beat("today"), beat("p1"), beat("p2"), beat("target")])
      ).ok
    ).toBe(true);
  });

  it("gives a phased beat one caption, and phase only with phases", () => {
    const spec = migration();
    expect(
      errorsOf({
        ...spec,
        story: [{ caption: { today: "a" } }, ...spec.story!.slice(1)],
      })
    ).toEqual([
      "story[0].caption: expected a string: with phases a beat belongs to one phase, so it has one caption",
    ]);
    expect(
      errorsOf({
        version: 1,
        parts: [{ id: "src", kind: "source" }],
        story: [{ caption: "a", phase: "p1" }],
      })
    ).toEqual([
      "story[0].phase: phase names a phase; it needs a top-level phases list",
    ]);
  });

  it("rejects a step that does not run in its beat's phase", () => {
    const spec = migration();
    const story = [...spec.story!];
    // old is retired in p2: a p2 beat cannot use it.
    story[3] = {
      ...story[3],
      steps: [{ verb: "drain", part: "old", card: "c0" }],
    };
    expect(errorsOf({ ...spec, story })).toEqual([
      `story[3].steps[0]: the step does not run in its beat's phase "p2": its part, its via rail and its in: list are in today, p1`,
    ]);
  });
});

describe("the clock across a phase boundary", () => {
  const flow = compileFlowOrThrow(migration());
  const today = arrangement(flow, "today")!.travel;
  const p1 = arrangement(flow, "p1")!.travel;

  it("keeps its place in the beat, playing or paused", () => {
    const s = initialClock(today);
    const into = 0.05;
    const crossing = { ...s, raw: beatStart(today, 1) + into, playing: true };
    expect(retarget(today, p1, crossing, false, "phase")).toEqual({
      ...crossing,
      raw: beatStart(p1, 1) + into,
    });
    // Stepping back lands on a beat start, and stays there.
    const back = { ...s, raw: beatStart(p1, 0) };
    expect(retarget(p1, today, back, false, "phase").raw).toBe(
      beatStart(today, 0)
    );
  });

  it("plays a chapter of another phase on to that phase's outcome", () => {
    const s = {
      ...initialClock(today),
      raw: beatStart(today, 1),
      playing: true,
      until: beatOutcome(today, 1),
    };
    expect(retarget(today, p1, s, false, "phase")).toMatchObject({
      raw: beatStart(p1, 1),
      playing: true,
      until: beatOutcome(p1, 1),
    });
  });

  it("an arrangement switch still lands on the outcome while playing", () => {
    const s = {
      ...initialClock(today),
      raw: beatStart(today, 1),
      playing: true,
    };
    expect(retarget(today, p1, s, false).raw).toBe(beatOutcome(p1, 1));
  });
});

describe("phase retargeting, for any clock", () => {
  const flow = compileFlowOrThrow(load(sessionMigration));
  test("keeps the story beat and lands inside it, never past its outcome", () =>
    hegel.test((tc) => {
      const from = tc.draw(gs.sampledFrom(flow.arrangements)).travel;
      const to = tc.draw(gs.sampledFrom(flow.arrangements)).travel;
      const raw = tc.draw(
        gs.floats({ minValue: 0, maxValue: from.period * 0.999 })
      );
      const playing = tc.draw(gs.booleans());
      const reduced = tc.draw(gs.booleans());
      const s = { ...initialClock(from), raw, playing };
      const i = shownBeat(from, s, reduced);
      const r = retarget(from, to, s, reduced, "phase");
      if (r.playing !== playing) throw new Error("playing changed");
      if (i < 0) {
        if (r.raw !== raw) throw new Error("moved before the first beat");
        return;
      }
      if (from.beats![i].story !== to.beats![shownBeat(to, r, reduced)].story)
        throw new Error(`beat ${i} became another story beat`);
      if (r.raw < beatStart(to, i) || r.raw > beatOutcome(to, i))
        throw new Error(`landed outside beat ${i}: ${r.raw}`);
    }));
});
