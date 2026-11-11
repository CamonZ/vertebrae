import { describe, expect, it } from "vitest";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import { stateAt } from "../timeline";
import {
  arrangement,
  cardTrack,
  compileFlow,
  compileFlowOrThrow,
  createFlowRegistry,
  flowSpecJsonSchema,
  formatFlowError,
  parseFlowSpec,
  validateFlowSpec,
  type FlowSpec,
  type PartKindDef,
} from "./index";

function load(text: string): FlowSpec {
  const r = parseFlowSpec(text);
  if (!r.ok) throw new Error(r.errors.map(formatFlowError).join("\n"));
  return r.value as FlowSpec;
}

const spec = load(inlineDiscussions);

function errorsOf(input: unknown, registry = createFlowRegistry()) {
  const r = compileFlow(input, { registry });
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors.map(formatFlowError);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the error tests break specs field by field */
/** A minimal valid spec to break in the error tests. */
const base = (): any => ({
  version: 1,
  parts: [
    { id: "src", kind: "source", position: { x: 0, y: 0 } },
    { id: "w", kind: "worker", position: { x: 400, y: 0 } },
  ],
  rails: [{ id: "jobs", from: "src.out", to: "w.in" }],
  cards: [
    { id: "job", token: "request", payload: { type: "value", value: 42 } },
  ],
  story: [
    {
      caption: "a job runs",
      steps: [
        { verb: "send", part: "src", card: "job" },
        { verb: "stage", part: "w", card: "job", via: "jobs" },
        { verb: "finish", part: "w", card: "job" },
      ],
    },
  ],
});

describe("8640ee9e story (prototype parity)", () => {
  const flow = compileFlowOrThrow(spec);
  const before = arrangement(flow, "before")!;
  const after = arrangement(flow, "after")!;

  it("compiles one spec into Before and After", () => {
    expect(flow.arrangements.map((a) => a.arrangement)).toEqual([
      "before",
      "after",
    ]);
  });

  it("spawns 4 processes before and 2 after (1 spawn + 1 resume)", () => {
    expect(before.counts.spawn).toBe(4);
    expect(before.counts.resume).toBeUndefined();
    expect(before.counts.close).toBe(4);
    expect(after.counts.spawn).toBe(1);
    expect(after.counts.resume).toBe(1);
    expect(after.counts.interrupt).toBe(1);
  });

  it("has the prototype's beats in order: 8 before, 9 after", () => {
    // Captions as printed by the prototype's build(mode) (diagrams/8640ee9e-machine.html).
    expect(before.beats.map((b) => b.caption.split(" ")[0])).toEqual([
      "Q1",
      "No",
      "Q2",
      "Q3",
      "…cancelled",
      "Collapsing",
      "Q4",
      "4",
    ]);
    expect(after.beats.map((b) => b.caption.split(" ")[0])).toEqual([
      "Q1",
      "The",
      "Q2",
      "An",
      "Q3",
      "…cancelled",
      "Collapsing",
      "Q4",
      "4",
    ]);
    for (const d of [before, after]) {
      const ts = d.beats.map((b) => b.t);
      expect([...ts].sort((x, y) => x - y)).toEqual(ts);
      expect(ts[0]).toBeCloseTo(0.6, 9);
      expect(d.period).toBeGreaterThan(ts[ts.length - 1]);
    }
  });

  it("runs the same input cards through both arrangements; only the outcome differs", () => {
    const lifecycle = (d: typeof before) =>
      d.parts.find((p) => p.id === "process")!.timeline.notes.map((n) => n[1]);
    expect(lifecycle(before)).toContain('spawn · --tools ""');
    expect(lifecycle(before)).toContain("stop · process closed");
    expect(lifecycle(after)).toContain("spawn · --tools Read,Grep,Glob");
    expect(lifecycle(after)).toContain("interrupted · process kept");
    expect(lifecycle(after)).toContain("resume · resume id");
    for (const id of ["q1", "q2", "q3", "q4"]) {
      expect(cardTrack(before, id).length).toBeGreaterThan(0);
      expect(cardTrack(after, id).length).toBeGreaterThan(0);
    }
  });

  it("allows Read and Grep and denies Edit only after the change", () => {
    const tools = after.parts.find((p) => p.id === "tools")!;
    expect(tools.change).toBe("added");
    expect(tools.timeline.notes.map((n) => n[1])).toEqual([
      "idle",
      "Read · deciding",
      "Grep · deciding",
      "allow",
      "allow",
      "Edit · deciding",
      "deny · read only",
      "idle",
    ]);
    const toolsBefore = before.parts.find((p) => p.id === "tools")!;
    expect(toolsBefore.presence).toBe("absent");
    expect(toolsBefore.timeline.cards).toEqual([]);
    expect(before.rails.find((r) => r.id === "call")!.presence).toBe("absent");
    expect(after.rails.find((r) => r.id === "call")!.change).toBe("added");
  });

  it("marks the changed session only in After, with its note", () => {
    const p = (d: typeof before) => d.parts.find((x) => x.id === "process")!;
    expect(p(before).change).toBe("unchanged");
    expect(p(after)).toMatchObject({
      change: "changed",
      changeNote: "one persistent session per thread",
      props: { lifecycle: "persistent" },
    });
  });

  it("hands a card from part to part along rails on one clock", () => {
    const track = cardTrack(after, "q1");
    expect(track.map((s) => s.layer)).toEqual(["you", "rail", "process"]);
    for (let i = 1; i < track.length; i++)
      expect(track[i].born).toBeGreaterThanOrEqual(track[i - 1].born);
    const arrival = after.markers.find(
      (m) => m.kind === "arrival" && m.card === "q1"
    )!;
    expect(arrival).toMatchObject({ part: "process", order: 1 });
    const rail = after.travel.cards.find((c) => c.id === "q1")!;
    expect(rail.dies).toBeCloseTo(arrival.t + 0.02, 9);
    // The card is drawn on the rail layer mid-flight, with its id and payload.
    const mid = (rail.born + rail.dies) / 2;
    const frame = stateAt(after.travel, mid);
    expect(frame.cards.map((c) => c.id)).toContain("q1");
    expect(rail.payload).toEqual({
      type: "text",
      value: "Please explain what this file does",
    });
  });

  it("evaluates every part timeline with stateAt and snaps reduced motion to diagram beats", () => {
    for (const p of after.parts) {
      expect(p.timeline.period).toBe(after.period);
      const f = stateAt(p.timeline, 5, { reducedMotion: true });
      const beat = after.beats.filter((b) => b.t <= 5).pop()!;
      const next = after.beats.find((b) => b.t > 5)!;
      expect(f.t).toBeGreaterThanOrEqual(beat.t);
      expect(f.t).toBeLessThan(next.t);
    }
  });

  it("keeps attachments on parts and beats", () => {
    const process = after.parts.find((p) => p.id === "process")!;
    expect(process.attachments.map((a) => [a.kind, a.status])).toEqual([
      ["ref", "verified"],
      ["ref", "verified"],
    ]);
    expect(after.beats.at(-1)!.attachments[0]).toMatchObject({
      kind: "note",
      source: "scenario",
    });
  });

  it("is deterministic", () => {
    expect(JSON.stringify(compileFlowOrThrow(spec))).toBe(JSON.stringify(flow));
  });
});

describe("validation errors name the spec path", () => {
  it("unknown component in a step", () => {
    const s = base();
    s.story[0].steps[1].part = "wroker";
    expect(errorsOf(s)).toContain(
      'story[0].steps[1].part: unknown component "wroker"; parts: src, w'
    );
  });

  it("unknown part kind lists the registered kinds and a suggestion", () => {
    const s = base();
    s.parts[1].kind = "wroker";
    expect(errorsOf(s)).toContain(
      'parts[1].kind: unknown part kind "wroker" (did you mean "worker"?); registered: aggregator, alert, approval, boundary, circuit breaker, client, event rail, guard, joiner, metric, pipeline, pool, queue, rate limiter, retry, router, session, source, splitter, timeout, trace, transform, worker'
    );
  });

  it("verb not supported by the target part", () => {
    const s = base();
    s.story[0].steps[1].verb = "drain";
    expect(errorsOf(s)).toContain(
      'story[0].steps[1].verb: worker "w" does not react to verb "drain"; its verbs: cancel, fail, finish, stage; "drain" is a verb of: pool, queue'
    );
    s.story[0].steps[1].verb = "decide";
    expect(errorsOf(s)).toContain(
      'story[0].steps[1].verb: worker "w" does not react to verb "decide"; its verbs: cancel, fail, finish, stage; "decide" is a verb of: guard, router'
    );
  });

  it("rail to a missing port, and to a missing part", () => {
    const s = base();
    s.rails[0].to = "w.inn";
    expect(errorsOf(s)).toContain(
      'rails[0].to: missing port on w (worker): "inn" (did you mean "in"?); ports: ctl, in, out'
    );
    s.rails[0].to = "ww.in";
    expect(errorsOf(s)).toContain(
      'rails[0].to: rail end names missing part "ww" (did you mean "w"?); parts: src, w'
    );
  });

  it("rail direction and token compatibility", () => {
    const s = base();
    s.rails[0].from = "w.in";
    s.rails[0].to = "src.out";
    const errs = errorsOf(s);
    expect(errs).toContain(
      "rails[0].from: port w.in is an in port; a rail leaves from an out port"
    );
    expect(errs).toContain(
      "rails[0].to: port src.out is an out port; a rail arrives at an in port"
    );
    const t = base();
    t.rails[0].to = "w.ctl";
    expect(errorsOf(t)).toContain(
      "rails[0]: src.out carries request, event, data, payload but w.ctl accepts control; no token kind can travel this rail"
    );
  });

  it("version, unknown fields, props and args", () => {
    const s = { ...base(), version: 2, extra: true };
    const errs = errorsOf(s);
    expect(errs).toContain("version: unsupported spec version 2; supported: 1");
    expect(errs[0]).toMatch(/^extra: unknown field "extra"; allowed: /);
    const p = base();
    p.parts[1] = {
      ...p.parts[1],
      kind: "session",
      props: { lifecycle: "forever" },
    };
    expect(errorsOf(p)).toContain(
      'parts[1].props.lifecycle: value "forever"; allowed: one-shot, persistent'
    );
    const a = base();
    a.story[0].steps[2].args = { wrok: 1 };
    expect(errorsOf(a)).toContain(
      'story[0].steps[2].args.wrok: unknown field "wrok" (did you mean "work"?); allowed: work'
    );
  });

  it("cards: missing, wrong token for the verb, wrong place", () => {
    const s = base();
    s.story[0].steps[1].card = "jbo";
    expect(errorsOf(s)).toContain(
      'story[0].steps[1].card: unknown card "jbo" (did you mean "job"?); cards: job'
    );
    const t = base();
    t.cards[0].token = "control";
    expect(errorsOf(t)).toContain(
      'story[0].steps[1].card: card "job" is a control; rail "jobs" carries request, data, payload'
    );
    const v = base();
    v.cards[0] = { id: "job", token: "result", origin: "w" };
    v.story[0].steps = [{ verb: "stage", part: "w", card: "job" }];
    expect(errorsOf(v)).toContain(
      'story[0].steps[0].card: worker verb "stage" takes request, data, payload; card "job" is a result'
    );
    const u = base();
    u.story[0].steps[1].via = undefined;
    expect(errorsOf(u)).toContain(
      'story[0].steps[1].card: card "job" is at "src"; travel a rail (via) to bring it to "w"'
    );
  });

  it("a rail must end at the step's part", () => {
    const s = base();
    s.parts.push({ id: "w2", kind: "worker" });
    s.story[0].steps[1].part = "w2";
    expect(errorsOf(s)).toContain(
      'story[0].steps[1].via: rail "jobs" arrives at "w", not at "w2"'
    );
  });

  it("attachments: unknown kind and bad fields", () => {
    const s = base();
    s.parts[0] = {
      ...s.parts[0],
      attachments: [
        { kind: "screenshot" },
        { kind: "ref", path: "a.rs", line: 0, status: "maybe" },
      ],
    };
    const errs = errorsOf(s);
    expect(errs[0]).toMatch(
      /^parts\[0\]\.attachments\[0\]\.kind: unknown attachment kind "screenshot"; registered: diff, formula, note, payload comparison, ref, schema diff, test summary, timing, ui crop$/
    );
    expect(errs).toContain(
      'parts[0].attachments[1].status: value "maybe"; allowed: inferred, verified'
    );
    expect(errs).toContain("parts[0].attachments[1].line: must be ≥ 1, got 0");
  });

  it("drill-down sub-specs are validated in place", () => {
    const s = base();
    s.parts[1] = {
      ...s.parts[1],
      drill: { spec: { version: 1, parts: [{ id: "x", kind: "nope" }] } },
    };
    expect(errorsOf(s)[0]).toMatch(
      /^parts\[1\]\.drill\.spec\.parts\[0\]\.kind: unknown part kind "nope"/
    );
  });

  it("parse errors carry the YAML line", () => {
    const r = parseFlowSpec("version: 1\nparts: [\n");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.errors[0].message).toMatch(/^invalid YAML at line \d+/);
  });
});

describe("registries: extend without changing the compiler", () => {
  const lamp: PartKindDef<{ colour: "green" | "red" }, { lit: number }> = {
    kind: "test lamp",
    job: "lights up",
    footprint: "S",
    bb: [280, 160, 80, 80],
    status: { x: 320, y: 270 },
    props: {
      colour: { type: "string", enum: ["green", "red"], default: "green" },
    },
    ports: {
      in: {
        side: "W",
        x: 280,
        y: 200,
        direction: "in",
        tokens: ["signal", "request"],
      },
    },
    init: () => ({ lit: 0 }),
    verbs: {
      glow: {
        duration: 0.9,
        card: "required",
        args: { times: { type: "integer", min: 1, default: 1 } },
        compile({ t, out, part, state, card, args }) {
          state.lit += Number(args.times);
          out.carry(
            [
              [
                [
                  [280, 200],
                  [320, 200],
                ],
                t,
                0.3,
              ],
            ],
            t,
            t + 0.5,
            {
              role: part.props.colour,
            }
          );
          out.note(t, `lit ×${state.lit}`, part.props.colour);
          out.marker({ t, kind: "glow", label: card!.label });
          return { consumed: true };
        },
      },
    },
  };

  it("a new part kind and a new attachment kind validate and compile", () => {
    const registry = createFlowRegistry();
    registry.parts.register(lamp);
    registry.attachments.register({
      kind: "metric snapshot",
      description: "a metric value at a time",
      fields: {
        name: { type: "string", required: true },
        value: { type: "number", required: true },
      },
    });
    const s: FlowSpec = {
      version: 1,
      parts: [
        { id: "src", kind: "source" },
        {
          id: "l",
          kind: "test lamp",
          props: { colour: "red" },
          attachments: [
            {
              kind: "metric snapshot",
              name: "lux",
              value: 3,
              status: "verified",
              source: "trace",
            },
          ],
        },
      ],
      rails: [{ id: "wire", from: "src.out", to: "l.in" }],
      cards: [
        {
          id: "ping",
          token: "request",
          payload: { type: "timestamp", value: "12:00:01", eventTime: 0.2 },
        },
      ],
      story: [
        {
          caption: "ping lights the lamp",
          steps: [
            { verb: "send", part: "src", card: "ping" },
            {
              verb: "glow",
              part: "l",
              card: "ping",
              via: "wire",
              args: { times: 2 },
            },
          ],
        },
      ],
    };
    expect(validateFlowSpec(s, registry)).toEqual([]);
    const d = compileFlowOrThrow(s, { registry }).arrangements[0];
    expect(d.arrangement).toBe("current");
    const l = d.parts.find((p) => p.id === "l")!;
    expect(l.timeline.notes.map((n) => n.slice(1))).toContainEqual([
      "lit ×2",
      "red",
    ]);
    expect(d.counts).toEqual({ arrival: 1, glow: 1 });
    expect(d.markers.find((m) => m.kind === "arrival")).toMatchObject({
      order: 1,
      eventTime: 0.2,
      card: "ping",
    });
    expect(l.attachments[0]).toMatchObject({
      kind: "metric snapshot",
      value: 3,
    });
    // Without the registration the same spec fails, naming the alternatives.
    const plain = createFlowRegistry();
    plain.attachments.register(registry.attachments.get("metric snapshot")!);
    expect(errorsOf(s, plain)).toEqual([
      'parts[1].kind: unknown part kind "test lamp"; registered: aggregator, alert, approval, boundary, circuit breaker, client, event rail, guard, joiner, metric, pipeline, pool, queue, rate limiter, retry, router, session, source, splitter, timeout, trace, transform, worker',
    ]);
    // The generated JSON Schema includes the new kinds.
    const schema = JSON.stringify(flowSpecJsonSchema(registry));
    expect(schema).toContain('"test lamp"');
    expect(schema).toContain('"metric snapshot"');
    expect(schema).toContain('"glow"');
  });

  it("refuses to register a kind twice", () => {
    const registry = createFlowRegistry();
    registry.parts.register(lamp);
    expect(() => registry.parts.register(lamp)).toThrow(/already registered/);
  });
});

describe("compiler features", () => {
  it("fills positions with the layout function when absent; keeps hand-given ones", () => {
    const s = base();
    s.parts[1] = { id: "w", kind: "worker" };
    const d = compileFlowOrThrow(s).arrangements[0];
    expect(d.parts[0]).toMatchObject({
      positioned: "given",
      position: { x: 0, y: 0 },
    });
    expect(d.parts[1].positioned).toBe("layout");
    expect(d.parts[1].position.x).toBeGreaterThan(320);
    const custom = compileFlowOrThrow(s, {
      layout: () => ({ w: { x: 7, y: 9 } }),
    }).arrangements[0];
    expect(custom.parts[1].position).toEqual({ x: 7, y: 9 });
    expect(custom.parts[1].ports.in).toMatchObject({
      x: 7 + 210 * 0.75,
      y: 9 + 200 * 0.75,
    });
  });

  it("compiles inline drill-down sub-specs and keeps artifact references", () => {
    const s = base();
    s.parts[0] = {
      ...s.parts[0],
      drill: { artifact: "877d5cd7-7507-43bb-85ee-c03cac7a80c4" },
    };
    s.parts[1] = { ...s.parts[1], drill: { spec: base() } };
    const d = compileFlowOrThrow(s).arrangements[0];
    expect(d.parts[0].drill).toEqual({
      kind: "artifact",
      artifact: "877d5cd7-7507-43bb-85ee-c03cac7a80c4",
    });
    const inner = d.parts[1].drill;
    expect(inner?.kind).toBe("inline");
    if (inner?.kind === "inline")
      expect(inner.flow.arrangements[0].beats).toHaveLength(1);
  });

  it("concurrent steps share a start; checkpoints mark the step end", () => {
    const s = base();
    s.parts.push({ id: "w2", kind: "worker" });
    s.cards = [...s.cards!, { id: "job2", token: "request", origin: "src" }];
    s.rails = [...s.rails!, { id: "jobs2", from: "src.out", to: "w2.in" }];
    s.story = [
      {
        caption: "two at once",
        steps: [
          { verb: "send", part: "src", card: "job" },
          {
            verb: "stage",
            part: "w",
            card: "job",
            via: "jobs",
            checkpoint: "job durable",
          },
          { verb: "stage", part: "w2", card: "job2", via: "jobs2", with: true },
        ],
      },
    ];
    const d = compileFlowOrThrow(s).arrangements[0];
    const starts = d.travel.cards.map((c) => c.born);
    expect(starts[0]).toBeCloseTo(starts[1], 9);
    const cp = d.markers.find((m) => m.kind === "checkpoint")!;
    expect(cp).toMatchObject({ part: "w", label: "job durable", card: "job" });
  });

  it("removed parts stand idle in After; their steps only run Before", () => {
    const s = base();
    s.parts[1] = { ...s.parts[1], change: "removed" };
    const flow = compileFlowOrThrow(s);
    const [before, after] = flow.arrangements;
    expect(before.parts[1].presence).toBe("live");
    expect(before.parts[1].timeline.cards.length).toBeGreaterThan(0);
    expect(after.parts[1]).toMatchObject({
      presence: "removed",
      change: "removed",
    });
    expect(after.parts[1].timeline.cards).toEqual([]);
    expect(after.rails[0].presence).toBe("removed");
    expect(after.travel.cards).toEqual([]);
  });

  it("the JSON Schema lists the registered vocabulary", () => {
    const schema = flowSpecJsonSchema(createFlowRegistry()) as {
      $defs: { part: { properties: { kind: { enum: string[] } } } };
    };
    expect(schema.$defs.part.properties.kind.enum).toEqual([
      "aggregator",
      "alert",
      "approval",
      "boundary",
      "circuit breaker",
      "client",
      "event rail",
      "guard",
      "joiner",
      "metric",
      "pipeline",
      "pool",
      "queue",
      "rate limiter",
      "retry",
      "router",
      "session",
      "source",
      "splitter",
      "timeout",
      "trace",
      "transform",
      "worker",
    ]);
  });

  it("accepts JSON as well as YAML", () => {
    const r = parseFlowSpec(JSON.stringify(base()));
    expect(r.ok && r.format).toBe("json");
    expect(compileFlow(r.ok ? r.value : null).ok).toBe(true);
  });
});

describe("card runtime state", () => {
  /* eslint-disable @typescript-eslint/no-explicit-any -- specs built inline */
  const gated = (outcome: "allow" | "deny"): any => ({
    version: 1,
    parts: [
      { id: "src", kind: "source", position: { x: 0, y: 0 } },
      { id: "g", kind: "guard", position: { x: 400, y: 0 } },
      { id: "w", kind: "worker", position: { x: 800, y: 0 } },
    ],
    rails: [
      { id: "call", from: "src.out", to: "g.in" },
      { id: "ok", from: "g.allow", to: "w.in" },
    ],
    cards: [{ id: "req", token: "request" }],
    story: [
      {
        caption: "a guarded call",
        steps: [
          { verb: "send", part: "src", card: "req" },
          {
            verb: "decide",
            part: "g",
            card: "req",
            via: "call",
            args: { outcome },
          },
          { verb: "stage", part: "w", card: "req", via: "ok" },
        ],
      },
    ],
  });

  it("a card leaves by the exit its verb chose", () => {
    expect(compileFlow(gated("allow")).ok).toBe(true);
    expect(errorsOf(gated("deny"))).toEqual([
      'story[0].steps[2].via: card "req" left g by its deny port, but rail "ok" starts at g.allow',
    ]);
  });

  const roundTrip = (finish: boolean): any => ({
    version: 1,
    parts: [
      { id: "c", kind: "client", position: { x: 0, y: 0 } },
      { id: "w", kind: "worker", position: { x: 500, y: 0 } },
    ],
    rails: [
      { id: "ask", from: "c.request", to: "w.in" },
      { id: "back", from: "w.out", to: "c.result" },
    ],
    cards: [{ id: "job", token: "request", label: "job" }],
    story: [
      {
        caption: "ask and render",
        steps: [
          { verb: "send", part: "c", card: "job" },
          { verb: "stage", part: "w", card: "job", via: "ask" },
          ...(finish ? [{ verb: "finish", part: "w", card: "job" }] : []),
          { verb: "render", part: "c", card: "job", via: "back" },
        ],
      },
    ],
  });

  it("a request returns as a result with its id", () => {
    const flow = compileFlowOrThrow(roundTrip(true));
    const d = flow.arrangements[0];
    const rides = d.travel.cards.filter((c) => c.id === "job");
    expect(rides).toHaveLength(2);
    expect(cardTrack(d, "job").map((x) => x.layer)).toEqual([
      "c",
      "rail",
      "w",
      "w",
      "rail",
      "c",
    ]);
    expect(errorsOf(roundTrip(false))).toEqual([
      'story[0].steps[2].card: card "job" is a request; rail "back" carries result',
    ]);
  });

  it("orders arrivals at a part by arrival time", () => {
    const s: any = {
      version: 1,
      parts: [
        { id: "far", kind: "source", position: { x: 0, y: 0 } },
        { id: "near", kind: "source", position: { x: 700, y: 300 } },
        { id: "w", kind: "worker", position: { x: 1000, y: 0 } },
      ],
      rails: [
        { id: "long", from: "far.out", to: "w.in" },
        { id: "short", from: "near.out", to: "w.in" },
      ],
      cards: [
        { id: "a", token: "request", origin: "far" },
        { id: "b", token: "request", origin: "near" },
      ],
      story: [
        {
          caption: "two jobs race",
          steps: [
            { verb: "stage", part: "w", card: "a", via: "long" },
            { verb: "stage", part: "w", card: "b", via: "short", with: true },
          ],
        },
      ],
    };
    const d = compileFlowOrThrow(s).arrangements[0];
    const arrivals = d.markers.filter((m) => m.kind === "arrival");
    expect(arrivals.map((m) => [m.card, m.order])).toEqual([
      ["b", 1],
      ["a", 2],
    ]);
    expect(arrivals[0].t).toBeLessThan(arrivals[1].t);
  });
  /* eslint-enable @typescript-eslint/no-explicit-any */
});

describe("spec hardening", () => {
  it("prototype names are not verbs, ports or fields", () => {
    const s = base();
    s.story[0].steps[0].verb = "constructor";
    expect(errorsOf(s).join("\n")).toMatch(
      /^story\[0\]\.steps\[0\]\.verb: source "src" does not react to verb "constructor"/m
    );
    const p = base();
    p.rails[0].to = "w.toString";
    expect(errorsOf(p).join("\n")).toMatch(
      /^rails\[0\]\.to: missing port on w \(worker\): "toString"/m
    );
    const a = base();
    a.story[0].steps[2].args = { hasOwnProperty: 1 };
    expect(errorsOf(a).join("\n")).toMatch(
      /^story\[0\]\.steps\[2\]\.args\.hasOwnProperty: unknown field/m
    );
  });

  it("rejects a drill-down that aliases its own spec; allows repeated aliases", () => {
    const cyclic = parseFlowSpec(`&root
version: 1
parts:
  - id: w
    kind: worker
    drill: { spec: *root }
`);
    expect(cyclic.ok).toBe(true);
    const errs = errorsOf(cyclic.ok ? cyclic.value : null);
    expect(errs).toEqual([
      "parts[0].drill.spec: drill-down spec contains itself (a recursive YAML alias); a drill-down must be a separate spec",
    ]);
    const shared = parseFlowSpec(`version: 1
parts:
  - { id: a, kind: worker, drill: { spec: &inner { version: 1, parts: [{ id: x, kind: worker }] } } }
  - { id: b, kind: worker, drill: { spec: *inner } }
`);
    expect(shared.ok && compileFlow(shared.value).ok).toBe(true);
  });

  it("limits drill-down nesting", () => {
    let spec: unknown = { version: 1, parts: [{ id: "x", kind: "worker" }] };
    for (let i = 0; i < 10; i++)
      spec = {
        version: 1,
        parts: [{ id: "x", kind: "worker", drill: { spec } }],
      };
    expect(errorsOf(spec)[0]).toMatch(/drill-downs nest deeper than 8 levels/);
  });

  it("registers and compiles a portless part", () => {
    const registry = createFlowRegistry();
    registry.parts.register({
      kind: "test trace",
      job: "records a run",
      footprint: "S",
      bb: [280, 160, 80, 80],
      status: { x: 320, y: 270 },
      ports: {},
      verbs: {
        record: {
          duration: 0.5,
          card: "none",
          compile({ t, out }) {
            out.note(t, "recorded");
          },
        },
      },
    });
    const r = compileFlow(
      {
        version: 1,
        parts: [{ id: "t", kind: "test trace" }],
        story: [{ caption: "record", steps: [{ verb: "record", part: "t" }] }],
      },
      { registry }
    );
    expect(r.ok).toBe(true);
  });

  it("arrangement overrides are partial updates over the base props", () => {
    const registry = createFlowRegistry();
    registry.parts.register({
      kind: "test dial",
      job: "shows a value",
      footprint: "S",
      bb: [280, 160, 80, 80],
      status: { x: 320, y: 270 },
      props: {
        x: { type: "string", required: true },
        y: { type: "string" },
      },
      ports: {},
      verbs: { show: { duration: 0.5, card: "none", compile() {} } },
    });
    const part = (after: unknown) => ({
      version: 1,
      parts: [
        {
          id: "d",
          kind: "test dial",
          change: "changed",
          props: { x: "base" },
          after,
        },
      ],
    });
    const r = compileFlow(part({ props: { y: "after" } }), { registry });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(arrangement(r.flow, "before")!.parts[0].props).toEqual({
        x: "base",
      });
      expect(arrangement(r.flow, "after")!.parts[0].props).toEqual({
        x: "base",
        y: "after",
      });
    }
    expect(errorsOf(part({ props: { z: 1 } }), registry)[0]).toMatch(
      /^parts\[0\]\.after\.props\.z: unknown field "z"/
    );
    const schema = flowSpecJsonSchema(registry) as any; // eslint-disable-line @typescript-eslint/no-explicit-any
    const dial = schema.$defs.part.allOf.find(
      (x: any) => x.if.properties.kind.const === "test dial" // eslint-disable-line @typescript-eslint/no-explicit-any
    );
    expect(dial.then.properties.props.required).toEqual(["x"]);
    expect(
      dial.then.properties.after.properties.props.required
    ).toBeUndefined();
  });
});
