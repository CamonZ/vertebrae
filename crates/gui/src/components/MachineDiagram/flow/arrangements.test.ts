import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import burstOptions from "./__fixtures__/burstOptions.flow.yaml?raw";
import everyMark from "./__fixtures__/everyMark.flow.yaml?raw";
import {
  arrangement,
  compileFlow,
  compileFlowOrThrow,
  formatFlowError,
  parseFlowSpec,
  type DiagramTimeline,
  type FlowSpec,
} from "./index";

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

const part = (d: DiagramTimeline, id: string) =>
  d.parts.find((p) => p.id === id)!;
const rail = (d: DiagramTimeline, id: string) =>
  d.rails.find((r) => r.id === id)!;
const marks = (d: DiagramTimeline) =>
  Object.fromEntries(d.parts.map((p) => [p.id, `${p.presence}/${p.change}`]));
const railMarks = (d: DiagramTimeline) =>
  Object.fromEntries(d.rails.map((r) => [r.id, `${r.presence}/${r.change}`]));

/** Options A and B over a current machine: x, y, z in A; y, z wired differently in B. */
const options = (): FlowSpec => ({
  version: 1,
  arrangements: ["current", "A", "B"],
  parts: [
    { id: "src", kind: "source" },
    { id: "w", kind: "worker" },
    { id: "x", kind: "rate limiter", in: ["A"] },
    { id: "y", kind: "queue", in: ["A", "B"] },
    { id: "z", kind: "store", in: ["A", "B"] },
  ],
  rails: [
    { id: "direct", from: "src.out", to: "w.in", in: ["current"] },
    { id: "sx", from: "src.out", to: "x.in" },
    { id: "xy", from: "x.out", to: "y.in" },
    { id: "sy", from: "src.out", to: "y.in", in: ["B"] },
    { id: "yzDead", from: "y.dead", to: "z.in", in: ["A"] },
    { id: "yzOut", from: "y.out", to: "z.in", in: ["B"] },
  ],
  cards: [{ id: "c", token: "request", origin: "src" }],
  story: [
    {
      id: "go",
      caption: { current: "straight in", A: "limited", B: "queued" },
      steps: [
        { verb: "send", part: "src", card: "c" },
        { verb: "stage", part: "w", card: "c", via: "direct" },
        { verb: "send", part: "x", card: "c", via: "sx" },
        { verb: "send", part: "y", card: "c", via: "xy" },
        { verb: "send", part: "y", card: "c", via: "sy" },
      ],
    },
  ],
});

describe("named arrangements", () => {
  it("compile to one timeline per arrangement, marked against the baseline", () => {
    const flow = compileFlowOrThrow(options());
    expect(flow.arrangements.map((d) => d.arrangement)).toEqual([
      "current",
      "A",
      "B",
    ]);
    expect(flow.baseline).toBe("current");
    const [current, a, b] = flow.arrangements;
    expect(marks(current)).toEqual({
      src: "live/unchanged",
      w: "live/unchanged",
      x: "absent/unchanged",
      y: "absent/unchanged",
      z: "absent/unchanged",
    });
    expect(marks(a)).toEqual({
      src: "live/unchanged",
      w: "live/unchanged",
      x: "live/added",
      y: "live/added",
      z: "live/added",
    });
    expect(marks(b)).toEqual({
      src: "live/unchanged",
      w: "live/unchanged",
      x: "absent/unchanged",
      y: "live/added",
      z: "live/added",
    });
    // y → z is wired from the dead-letter port in A and from out in B.
    expect(railMarks(a)).toEqual({
      direct: "removed/removed",
      sx: "live/added",
      xy: "live/added",
      sy: "absent/unchanged",
      yzDead: "live/added",
      yzOut: "absent/unchanged",
    });
    expect(railMarks(b)).toEqual({
      direct: "removed/removed",
      sx: "absent/unchanged",
      xy: "absent/unchanged",
      sy: "live/added",
      yzDead: "absent/unchanged",
      yzOut: "live/added",
    });
    expect(current.beats.map((x) => x.caption)).toEqual(["straight in"]);
    expect(a.beats.map((x) => x.caption)).toEqual(["limited"]);
    expect(b.beats.map((x) => x.caption)).toEqual(["queued"]);
  });

  it("run each step only where its part and rail are, and list it against the baseline", () => {
    const flow = compileFlowOrThrow(options());
    const [current, a, b] = flow.arrangements;
    expect(part(current, "w").steps.map((s) => s.verb)).toEqual(["stage"]);
    expect(part(a, "w").steps).toEqual([]);
    expect(part(a, "x").steps.map((s) => s.verb)).toEqual(["send"]);
    expect(part(a, "y").steps.map((s) => s.verb)).toEqual(["send"]);
    expect(part(b, "y").steps.map((s) => s.verb)).toEqual(["send"]);
    expect(current.beats[0].changes).toEqual([]);
    expect(a.beats[0].changes.map((c) => `${c.change} ${c.label}`)).toEqual([
      "removed worker · stage",
      "added rate limiter · send",
      "added queue · send",
    ]);
    expect(b.beats[0].changes.map((c) => `${c.change} ${c.label}`)).toEqual([
      "removed worker · stage",
      "added queue · send",
    ]);
  });

  it("share one layout: parts keep their place in every arrangement", () => {
    const flow = compileFlowOrThrow(options());
    const where = (d: DiagramTimeline) =>
      d.parts.map((p) => [p.id, p.position, p.scale]);
    for (const d of flow.arrangements) {
      expect(where(d)).toEqual(where(flow.arrangements[0]));
      expect([d.width, d.height]).toEqual([
        flow.arrangements[0].width,
        flow.arrangements[0].height,
      ]);
      expect(rail(d, "yzOut").points).toEqual(
        rail(flow.arrangements[0], "yzOut").points
      );
    }
  });

  it("mark a part changed where its override differs from the baseline's", () => {
    const spec: FlowSpec = {
      version: 1,
      arrangements: ["base", "same", "bigger", "noted"],
      parts: [
        {
          id: "q",
          kind: "queue",
          changeNote: "default note",
          arrangement: {
            base: { props: { slots: 2 } },
            same: { props: { slots: 2 } },
            bigger: {
              props: { slots: 5 },
              portChanges: { dead: "added" },
            },
            noted: { changeNote: "only the note" },
          },
        },
      ],
    };
    const flow = compileFlowOrThrow(spec);
    const q = (name: string) => part(arrangement(flow, name)!, "q");
    expect(q("base").change).toBe("unchanged");
    expect(q("same").change).toBe("unchanged");
    expect(q("same").changeNote).toBeUndefined();
    expect(q("bigger").change).toBe("changed");
    expect(q("bigger").props.slots).toBe(5);
    expect(q("bigger").changeNote).toBe("default note");
    expect(q("bigger").portChanges).toEqual({ dead: "added" });
    // slots default to 3: no props override differs from base's 2.
    expect(q("noted").change).toBe("changed");
    expect(q("noted").changeNote).toBe("only the note");
    expect(q("base").portChanges).toEqual({});
  });

  it("take the baseline from `baseline`, and labels from the list", () => {
    const flow = compileFlowOrThrow({
      ...options(),
      arrangements: [
        { name: "A", label: "Option A" },
        "B",
        { name: "current" },
      ],
      baseline: "current",
    });
    expect(flow.baseline).toBe("current");
    expect(flow.labels).toEqual({
      A: "Option A",
      B: "B",
      current: "Current",
    });
    expect(flow.arrangements.map((d) => d.arrangement)).toEqual([
      "A",
      "B",
      "current",
    ]);
    expect(part(arrangement(flow, "A")!, "x").change).toBe("added");
    expect(part(arrangement(flow, "current")!, "x").change).toBe("unchanged");
  });

  it("read band values per arrangement, and count the meter in each", () => {
    const flow = compileFlowOrThrow({
      ...options(),
      band: {
        rows: [
          {
            name: "entry",
            beats: ["go"],
            note: "how a job gets in",
            chips: { current: ["direct"], A: ["limit", "queue"], B: ["queue"] },
          },
        ],
        meter: { label: "hops", marker: "arrival" },
      },
    });
    const chips = (name: string) =>
      arrangement(flow, name)!.band!.rows[0].chips.map((c) => c.text);
    expect(chips("current")).toEqual(["direct"]);
    expect(chips("A")).toEqual(["limit", "queue"]);
    expect(chips("B")).toEqual(["queue"]);
    expect(arrangement(flow, "A")!.band!.meter!.footnote).toBe(
      "current: 1  ·  A: 2  ·  B: 1"
    );
    // One band geometry for every arrangement.
    const geometry = (d: DiagramTimeline) => {
      const { y, x0, x1, chipX, y1 } = d.band!;
      return { y, x0, x1, chipX, y1, meterX: d.band!.meter!.x };
    };
    for (const d of flow.arrangements)
      expect(geometry(d)).toEqual(geometry(flow.arrangements[0]));
  });

  it("let an arrangement without a caption continue the previous beat", () => {
    const spec = options();
    const flow = compileFlowOrThrow({
      ...spec,
      story: [
        ...spec.story!,
        { caption: { A: "only A says more" }, hold: 0.5 },
      ],
    });
    expect(arrangement(flow, "A")!.beats.map((b) => b.caption)).toEqual([
      "limited",
      "only A says more",
    ]);
    expect(arrangement(flow, "B")!.beats.map((b) => b.caption)).toEqual([
      "queued",
    ]);
  });
});

describe("the Before/After shorthand", () => {
  const flow = compileFlowOrThrow(load(everyMark));
  const [before, after] = flow.arrangements;
  const portsAndStages = (d: DiagramTimeline) =>
    Object.fromEntries(
      d.parts
        .filter((p) => Object.keys(p.portChanges).length || p.stageMarks.length)
        .map((p) => [
          p.id,
          [p.portChanges, p.stageMarks.map((s) => `${s.name}:${s.change}`)],
        ])
    );
  const beatMarks = (d: DiagramTimeline) =>
    d.beats.map((b) => [
      b.caption,
      b.changes.map((c) => `${c.change} ${c.label}`),
    ]);

  it("compiles every mark kind to before and after, before the unmarked baseline", () => {
    expect(flow.arrangements.map((d) => d.arrangement)).toEqual([
      "before",
      "after",
    ]);
    expect(flow.baseline).toBe("before");
    expect(flow.labels).toEqual({ before: "Before", after: "After" });
    expect(marks(before)).toEqual({
      src: "live/unchanged",
      w: "live/unchanged",
      q: "absent/unchanged",
      st: "live/unchanged",
      pipe: "live/unchanged",
    });
    expect(marks(after)).toEqual({
      src: "live/unchanged",
      w: "live/changed",
      q: "live/added",
      st: "removed/removed",
      pipe: "live/changed",
    });
    expect(railMarks(before)).toEqual({
      r1: "live/unchanged",
      r2: "absent/unchanged",
      r3: "live/unchanged",
    });
    expect(railMarks(after)).toEqual({
      r1: "live/unchanged",
      r2: "live/added",
      r3: "removed/removed",
    });
    expect(portsAndStages(before)).toEqual({});
    expect(portsAndStages(after)).toEqual({
      w: [{ ctl: "added", out: "changed" }, []],
      pipe: [{}, ["lint:added", "test:changed"]],
    });
    expect(part(before, "w").changeNote).toBeUndefined();
    expect(part(after, "w").changeNote).toBe("retries on crash");
  });

  it("runs marked steps on their side and reads captions and band values per side", () => {
    expect(beatMarks(before)).toEqual([
      ["a job arrives", []],
      ["it crashes", []],
      ["stored before", []],
      ["the pipeline", []],
    ]);
    // b4 has no After caption, so its removed steps list on b3's beat.
    expect(beatMarks(after)).toEqual([
      ["a job arrives", []],
      ["it finishes after a retry", ["changed worker · finish"]],
      ["queued now", ["removed source · send", "removed store · record"]],
      ["the pipeline", ["added pipeline · stage"]],
    ]);
    const band = (d: DiagramTimeline) =>
      d.band!.rows.map((r) => [r.note, r.chips.map((c) => c.text)]);
    expect(band(before)).toEqual([
      ["lost", ["crash", "drop"]],
      [undefined, ["buffer"]],
    ]);
    expect(band(after)).toEqual([
      ["retried", ["crash", "retry", "finish"]],
      [undefined, ["buffer"]],
    ]);
  });
});

describe("the three-option reference spec", () => {
  const flow = compileFlowOrThrow(load(burstOptions));

  it("compiles to current, A and B with their own parts and rails", () => {
    expect(flow.arrangements.map((d) => d.arrangement)).toEqual([
      "current",
      "A",
      "B",
    ]);
    const [current, a, b] = flow.arrangements;
    expect(marks(current)).toMatchObject({
      limiter: "absent/unchanged",
      buffer: "absent/unchanged",
      parked: "absent/unchanged",
    });
    expect(marks(a)).toMatchObject({
      limiter: "live/added",
      buffer: "live/added",
      parked: "live/added",
    });
    expect(marks(b)).toMatchObject({
      limiter: "absent/unchanged",
      buffer: "live/added",
      parked: "live/added",
    });
    expect(part(b, "parked").changeNote).toBe(
      "journals every job before the api sees it"
    );
    expect(rail(a, "dead").presence).toBe("live");
    expect(rail(b, "dead").presence).toBe("absent");
    expect(rail(b, "journal").change).toBe("added");
    expect(flow.labels.A).toBe("A · limit + queue");
  });
});

describe("named arrangement errors name the arrangement", () => {
  it("rejects unknown names in in:, overrides, captions and band values", () => {
    const s = options() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.parts[2].in = ["A", "C"];
    s.parts[3].arrangement = { D: { props: { slots: 1 } } };
    s.story[0].caption = { current: "x", Q: "y" };
    s.band = {
      rows: [{ name: "r", beats: ["go"], chips: { current: ["a"], A: ["b"] } }],
    };
    expect(errorsOf(s)).toEqual([
      expect.stringMatching(
        /^parts\[2\]\.in\[1\]: unknown arrangement "C".*arrangements: A, B, current/
      ),
      expect.stringMatching(
        /^parts\[3\]\.arrangement\.D: override names unknown arrangement "D"/
      ),
      expect.stringMatching(
        /^story\[0\]\.caption\.Q: caption names unknown arrangement "Q"/
      ),
      "band.rows[0].chips.B: is required (give every arrangement: current, A, B)",
    ]);
  });

  it("rejects a baseline that names no arrangement", () => {
    expect(errorsOf({ ...options(), baseline: "after" })).toEqual([
      expect.stringMatching(
        /^baseline: baseline names missing arrangement "after".*arrangements: A, B, current/
      ),
    ]);
    expect(
      errorsOf({
        version: 1,
        baseline: "A",
        parts: [{ id: "p", kind: "source" }],
      })
    ).toEqual([
      "baseline: needs a top-level arrangements list to name the baseline from",
    ]);
  });

  it("rejects a step listed in an arrangement where its part or rail is absent", () => {
    const s = options() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.story[0].steps[2].in = ["A", "B"];
    s.story[0].steps[3].in = ["current"];
    expect(errorsOf(s)).toEqual([
      'story[0].steps[2].in: lists arrangement "B", where its part "x" is absent (its part "x" is in: A)',
      'story[0].steps[2].in: lists arrangement "B", where its rail "sx" is absent (its rail "sx" is in: A)',
      'story[0].steps[3].in: lists arrangement "current", where its part "y" is absent (its part "y" is in: A, B)',
      'story[0].steps[3].in: lists arrangement "current", where its rail "xy" is absent (its rail "xy" is in: A)',
      "story[0].steps[3]: the step runs in no arrangement: its part, its via rail and its in: list share none",
    ]);
  });

  it("rejects a rail listed where one of its parts is absent", () => {
    const s = options() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.rails[2].in = ["B"];
    expect(errorsOf(s)).toEqual([
      'rails[2].in: lists arrangement "B", where its part "x" is absent (its part "x" is in: A)',
      "rails[2]: the rail is in no arrangement: its two parts (and its in: list) share none",
      expect.stringMatching(
        /^story\[0\]\.steps\[3\]: the step runs in no arrangement/
      ),
    ]);
  });

  it("names the arrangement of a card that cannot travel there", () => {
    const s = options() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    // In B the card is still at src when y sends it on to z.
    s.story[0].steps.push({ verb: "drain", part: "y", card: "c" });
    s.story[0].steps.push({
      verb: "record",
      part: "z",
      card: "c",
      via: "yzDead",
    });
    expect(errorsOf(s)).toEqual([
      expect.stringMatching(
        /^story\[0\]\.steps\[6\]\.via: card "c" left y by its out port, but rail "yzDead" starts at y\.dead \(in the A arrangement\)$/
      ),
    ]);
  });

  it("rejects shorthand marks and overrides beside named arrangements", () => {
    const s = options() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.parts[0].change = "added";
    s.parts[1].after = { props: {} };
    s.parts[1].portChanges = { ctl: "added" };
    s.rails[0].change = "removed";
    s.story[0].steps[0].change = "added";
    const errors = errorsOf(s);
    expect(errors).toEqual([
      expect.stringMatching(
        /^parts\[0\]\.change: with named arrangements marks are computed from in:/
      ),
      expect.stringMatching(
        /^parts\[1\]\.after: before\/after overrides are the Before\/After shorthand/
      ),
      expect.stringMatching(
        /^parts\[1\]\.portChanges: with named arrangements give portChanges per arrangement/
      ),
      expect.stringMatching(
        /^rails\[0\]\.change: with named arrangements marks are computed from in:/
      ),
      expect.stringMatching(
        /^story\[0\]\.steps\[0\]\.change: with named arrangements marks are computed from in:/
      ),
    ]);
  });

  it("rejects in: and arrangement: without a top-level arrangements list", () => {
    expect(
      errorsOf({
        version: 1,
        parts: [{ id: "p", kind: "source", in: ["A"], arrangement: { A: {} } }],
      })
    ).toEqual([
      "parts[0].in: in names arrangements; it needs a top-level arrangements (or phases) list",
      "parts[0].arrangement: arrangement names arrangements; it needs a top-level arrangements (or phases) list",
    ]);
  });

  it("rejects a malformed arrangements list", () => {
    expect(
      errorsOf({
        version: 1,
        arrangements: [
          "A",
          "A",
          "1x",
          { label: "no name" },
          { name: "B", x: 1 },
        ],
        parts: [{ id: "p", kind: "source", in: [] }],
      })
    ).toEqual([
      'arrangements[1]: duplicate arrangement "A" (first declared at arrangements[0])',
      "arrangements[2]: expected an arrangement name: a letter, then letters, digits, - or _ (or { name, label })",
      "arrangements[3].name: is required",
      expect.stringMatching(/^arrangements\[4\]\.x: unknown field "x"/),
      "parts[0].in: needs at least one arrangement",
    ]);
    expect(
      errorsOf({
        version: 1,
        arrangements: [],
        parts: [{ id: "p", kind: "source" }],
      })
    ).toEqual(["arrangements: needs at least one arrangement"]);
  });

  it("checks a named override's props, marks and membership", () => {
    const s = options() as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    s.parts[2].arrangement = { B: { props: { tokens: "many" } } };
    s.parts[3].arrangement = {
      A: { portChanges: { side: "added" }, stageChanges: { x: "added" } },
    };
    expect(errorsOf(s)).toEqual([
      'parts[2].arrangement.B: the part is not in arrangement "B" (in: A)',
      expect.stringMatching(
        /^parts\[2\]\.arrangement\.B\.props\.tokens: expected a number/
      ),
      expect.stringMatching(
        /^parts\[3\]\.arrangement\.A\.portChanges\.side: queue has no port "side"/
      ),
      "parts[3].arrangement.A.stageChanges: queue has no stages to mark",
    ]);
  });
});

describe("drill-downs mix the two modes", () => {
  const child = (extra: Partial<FlowSpec>, parts: FlowSpec["parts"]) => ({
    spec: { version: 1, parts, ...extra },
  });
  const drilled = (d: DiagramTimeline, id: string) => {
    const t = part(d, id).drill;
    if (t?.kind !== "inline") throw new Error(`${id} drills nowhere`);
    return t.flow;
  };

  it("keeps each level's own arrangements and baseline", () => {
    const flow = compileFlowOrThrow({
      version: 1,
      arrangements: ["current", "A"],
      parts: [
        {
          id: "w",
          kind: "worker",
          drill: child({}, [
            { id: "a", kind: "source" },
            { id: "b", kind: "queue", change: "added" },
          ]),
        },
        {
          id: "q",
          kind: "queue",
          in: ["A"],
          drill: child({ arrangements: ["X", "Y"], baseline: "Y" }, [
            { id: "a", kind: "source" },
            { id: "b", kind: "store", in: ["X"] },
          ]),
        },
      ],
    } as FlowSpec);
    expect(flow.arrangements.map((d) => d.arrangement)).toEqual([
      "current",
      "A",
    ]);
    for (const d of flow.arrangements) {
      const shorthand = drilled(d, "w");
      expect(shorthand.arrangements.map((c) => c.arrangement)).toEqual([
        "before",
        "after",
      ]);
      expect(shorthand.baseline).toBe("before");
      expect(marks(shorthand.arrangements[1]).b).toBe("live/added");
    }
    const named = drilled(arrangement(flow, "A")!, "q");
    expect(named.arrangements.map((c) => c.arrangement)).toEqual(["X", "Y"]);
    expect(named.baseline).toBe("Y");
    expect(marks(arrangement(named, "X")!).b).toBe("live/added");
    expect(marks(arrangement(named, "Y")!).b).toBe("absent/unchanged");
  });

  it("does not let a child name its parent's arrangements, or a named parent forbid a shorthand child", () => {
    const shorthandParent = {
      version: 1,
      parts: [
        {
          id: "w",
          kind: "worker",
          change: "changed",
          changeNote: "now drills",
          drill: child({ arrangements: ["X"] }, [
            { id: "a", kind: "source", in: ["before"] },
          ]),
        },
      ],
    };
    expect(errorsOf(shorthandParent)).toEqual([
      expect.stringMatching(
        /^parts\[0\]\.drill\.spec\.parts\[0\]\.in\[0\]: unknown arrangement "before".*arrangements: X/
      ),
    ]);
    const namedParent = {
      version: 1,
      arrangements: ["current", "A"],
      parts: [
        {
          id: "w",
          kind: "worker",
          drill: child({}, [
            { id: "a", kind: "source", in: ["A"] },
            { id: "b", kind: "queue", change: "added" },
          ]),
        },
      ],
    };
    expect(errorsOf(namedParent)).toEqual([
      "parts[0].drill.spec.parts[0].in: in names arrangements; it needs a top-level arrangements (or phases) list",
    ]);
  });
});

describe("the authoring recipes", () => {
  const dir = resolve("../../docs/agent-context/machine-diagrams/recipes");
  const blocks = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .flatMap((f) =>
      [
        ...readFileSync(join(dir, f), "utf8").matchAll(
          /^```flow\n([\s\S]*?)^```$/gm
        ),
      ].map((m, i): [string, string] => [`${f}.${i}`, m[1]])
    );

  it.each(blocks)("%s compiles", (_, source) => {
    expect(() => compileFlowOrThrow(load(source))).not.toThrow();
  });

  it("the options recipe compiles to its named arrangements", () => {
    const [, source] = blocks.find(([n]) => n.startsWith("options.md"))!;
    const flow = compileFlowOrThrow(load(source));
    expect(flow.arrangements.map((d) => d.arrangement)).toEqual([
      "current",
      "A",
      "B",
    ]);
    expect(marks(arrangement(flow, "B")!)).toMatchObject({
      limiter: "absent/unchanged",
      buffer: "live/added",
      parked: "live/added",
    });
  });
});
