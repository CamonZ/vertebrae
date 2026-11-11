/**
 * Implemented catalogue parts: every scenario, universal state and change
 * mark renders in light and dark with palette roles only; the silhouette
 * (labels off) still identifies each part; each part is registered in the
 * flow-spec registry with the same frame, status anchor and story verbs as
 * the catalogue, and a ```flow spec using the parts compiles.
 */
import { render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import universal from "../__fixtures__/galleryUniversalStates.json";
import { stateLabel, type ChangeMark } from "../accessibility";
import { MachineDiagram } from "../MachineDiagram";
import { createFlowRegistry } from "../flow/defaults";
import { arrangement, compileFlow } from "../flow/compile";
import { parseFlowSpec } from "../flow/parse";
import { validateFlowSpec } from "../flow/validate";
import { stateAt } from "../timeline";
import { UNIVERSAL_STATES, statePose } from "../universalStates";
import {
  CatalogPart,
  MACHINE_PARTS,
  machinePartFor,
  scenarioTimings,
  type CatalogView,
  type MachinePartDef,
} from "./index";

const PARTS = Object.entries(MACHINE_PARTS).map(
  ([name, def]) => [name, def as unknown as MachinePartDef] as const
);
const MARKS: readonly ChangeMark[] = [
  "unchanged",
  "added",
  "changed",
  "removed",
];

interface UniversalEntry {
  name: string;
  job: string;
  scenarios: { name: string; period: number; still: number }[];
  states: Record<string, { t: number; si: number; status: [string, string] }>;
}
const GALLERY = new Map(
  (universal as unknown as UniversalEntry[]).map((e) => [e.name, e] as const)
);

/** Catalogue v2.1 story verbs per part (catalogue "Story verbs"). */
const STORY_VERBS: Record<string, readonly string[]> = {
  source: ["observe", "send", "spawn", "tick"],
  client: ["cancel", "render", "send", "wait"],
  worker: ["cancel", "fail", "finish", "stage"],
  transform: ["fail", "transform"],
  router: ["decide", "fail", "route"],
  splitter: ["fail", "send", "split"],
  joiner: ["cancel", "fail", "join", "release", "wait"],
  aggregator: ["fail", "flush", "record", "reduce"],
  pipeline: ["cancel", "fail", "finish", "stage"],
  pool: ["close", "drain", "release", "spawn", "wait"],
  queue: ["drain", "fail", "retry", "send", "wait"],
  "event rail": ["observe", "resume", "send", "wait"],
  retry: ["fail", "retry", "send", "wait"],
  timeout: ["cancel", "expire", "tick", "wait"],
  "rate limiter": ["fail", "refill", "send", "wait"],
  "circuit breaker": ["fail", "probe", "reset", "send", "trip"],
  guard: ["decide", "fail", "validate"],
  approval: ["approve", "expire", "reject", "wait"],
  boundary: ["close", "cross", "fail", "spawn"],
  metric: ["fail", "measure", "observe"],
  trace: ["finish", "span", "stage"],
  alert: ["acknowledge", "escalate", "notify"],
  store: ["delete", "read", "record", "snapshot"],
  cache: ["expire", "miss", "read", "record"],
  document: ["read", "record", "version"],
  "state machine": ["cancel", "decide", "fail", "finish", "stage"],
  "reactive cell": ["notify", "observe", "record"],
  schema: ["decide", "fail", "validate"],
  transaction: ["commit", "rollback", "stage"],
  lock: ["acquire", "expire", "release", "wait"],
  // The catalogue lists connect, stage, cancel, close and resume; `finish`
  // (the reply leaves) predates the drawing and the inline-discussions flow uses it.
  session: ["cancel", "close", "connect", "finish", "resume", "stage"],
};

function Cell({
  def,
  view,
  change,
  labels,
}: {
  def: MachinePartDef;
  view: CatalogView;
  change?: ChangeMark;
  labels?: boolean;
}) {
  return (
    <MachineDiagram label={def.part.name} labels={labels}>
      <CatalogPart
        def={def}
        view={view}
        change={change}
        changeNote={change === "changed" ? "what changed" : undefined}
        reducedMotion={false}
      />
    </MachineDiagram>
  );
}

/** A part draws with palette roles only (--md-*): no literal colour values. */
function expectPaletteOnly(html: string) {
  const colours = html.match(
    /(?:fill|stroke)="(?!var\(--md-|none|url\()[^"]*"/g
  );
  expect(colours).toBeNull();
  expect(html).not.toMatch(/#[0-9a-fA-F]{3,8}\b(?![\w-])/);
}

afterEach(() => {
  document.documentElement.classList.remove("light");
});

describe.each(PARTS)("%s", (name, def) => {
  const gallery = GALLERY.get(name)!;

  it("matches the gallery's identity, scenarios and universal states", () => {
    expect(gallery).toBeDefined();
    expect(def.part.job).toBe(gallery.job);
    gallery.scenarios.forEach((sc, i) => {
      expect(def.scenarios[i].name).toBe(sc.name);
      expect(def.scenarios[i].timeline.period).toBeCloseTo(sc.period, 6);
      expect(def.scenarios[i].still).toBeCloseTo(sc.still, 6);
    });
    for (const state of UNIVERSAL_STATES) {
      const pose = statePose(scenarioTimings(def), state);
      const e = gallery.states[state];
      expect(pose.t).toBeCloseTo(e.t, 3);
      expect(pose.scenario).toBe(e.si);
      const frame = stateAt(def.scenarios[pose.scenario].timeline, pose.t, {
        pose: pose.pose,
      });
      expect([frame.status.current.text, frame.status.current.role]).toEqual(
        e.status
      );
    }
  });

  it.each(["dark", "light"] as const)(
    "renders every scenario, universal state and change mark in %s",
    (theme) => {
      if (theme === "light") document.documentElement.classList.add("light");
      const views: CatalogView[] = [
        ...def.scenarios.map(
          (sc, index): CatalogView => ({ kind: "scenario", index, t: sc.still })
        ),
        ...UNIVERSAL_STATES.map(
          (state): CatalogView => ({ kind: "state", state })
        ),
      ];
      for (const view of views)
        for (const change of MARKS) {
          const { container, unmount } = render(
            <Cell def={def} view={view} change={change} />
          );
          const part = container.querySelector(`[data-part="${name}"]`)!;
          expect(part).not.toBeNull();
          expect(part.getAttribute("role")).toBe("img");
          if (change !== "unchanged")
            expect(
              container.querySelector(`[data-mark="${change}"]`)
            ).not.toBeNull();
          for (const el of container.querySelectorAll("text"))
            expect(Number(el.getAttribute("font-size"))).toBeGreaterThanOrEqual(
              18
            );
          expectPaletteOnly(part.innerHTML);
          unmount();
        }
    }
  );

  it("names part, state and change in its accessible text", () => {
    render(<Cell def={def} view={{ kind: "state", state: "ok" }} />);
    expect(
      screen.getByRole("img", {
        name: stateLabel(def.part, "ok", "unchanged"),
      })
    ).toBeInTheDocument();
  });

  it("silhouette: with labels hidden only mechanism glyphs remain", () => {
    const { container } = render(
      <Cell
        def={def}
        view={{ kind: "scenario", index: 0, t: def.scenarios[0].still }}
        labels={false}
      />
    );
    // Labels go; a glyph that is part of the mechanism (the source caret) stays.
    for (const el of container.querySelectorAll("text")) {
      expect(el.querySelector("tspan")).toBeNull();
      expect(el.textContent).toHaveLength(1);
    }
    // A frame or a rail identifies every part; the event rail is all rail and
    // the trace (no ports) is all frame.
    const frames = container.querySelectorAll(".md-box").length;
    const rails = container.querySelectorAll(".md-rail").length;
    expect(frames + rails).toBeGreaterThan(0);
    if (name !== "event rail") expect(frames).toBeGreaterThan(0);
    if (name !== "trace") expect(rails).toBeGreaterThan(0);
  });

  it("is registered in the flow-spec registry with the catalogue geometry and verbs", () => {
    const kind = createFlowRegistry().parts.get(name)!;
    expect(kind).toBeDefined();
    expect(kind.job).toBe(def.part.job);
    expect(kind.family).toBe(def.family);
    expect(kind.footprint).toBe(def.footprint);
    expect(kind.bb).toEqual(def.bb);
    expect(kind.status).toEqual(def.status);
    expect(Object.keys(kind.verbs).sort()).toEqual(STORY_VERBS[name]);
    const [x, y, w, h] = def.bb;
    for (const p of Object.values(kind.ports)) {
      expect(p.x).toBeGreaterThanOrEqual(x);
      expect(p.x).toBeLessThanOrEqual(x + w);
      expect(p.y).toBeGreaterThanOrEqual(y);
      expect(p.y).toBeLessThanOrEqual(y + h);
    }
    expect(machinePartFor(name)).toBe(def);
  });
});

describe("silhouettes", () => {
  it("differ between every pair of parts (frame = type, VL-01)", () => {
    const shapes = PARTS.map(([, def]) => {
      const { container, unmount } = render(
        <Cell
          def={def}
          view={{ kind: "state", state: "idle" }}
          labels={false}
        />
      );
      const svg = container.querySelector(".md-part")!.innerHTML;
      unmount();
      return svg;
    });
    expect(new Set(shapes).size).toBe(PARTS.length);
  });
});

const FAN_OUT_IN = `
version: 1
title: request fans out and back in
parts:
  - { id: src, kind: source }
  - { id: edge, kind: boundary, props: { region: SACRUM PROCESS } }
  - { id: route, kind: router }
  - { id: parse, kind: transform }
  - { id: fan, kind: splitter }
  - { id: join, kind: joiner }
  - { id: sum, kind: aggregator }
  - { id: ci, kind: pipeline }
  - { id: view, kind: client }
rails:
  - { id: call, from: src.out, to: edge.in }
  - { id: hop, from: edge.out, to: route.in }
  - { id: tasks, from: route.r1, to: parse.in }
  - { id: shaped, from: parse.out, to: fan.in }
  - { id: left, from: fan.b1, to: join.a }
  - { id: right, from: fan.b2, to: join.b }
  - { id: joined, from: join.out, to: sum.in }
  - { id: summary, from: sum.out, to: ci.in }
  - { id: shipped, from: ci.out, to: view.result }
cards:
  - { id: req, token: request, label: /tasks/9 }
  - { id: c1, token: copy, label: copy 1, origin: fan }
  - { id: c2, token: copy, label: copy 2, origin: fan }
  - { id: both, token: data, label: a + b, origin: join }
  - { id: one, token: data, label: summary, origin: sum }
story:
  - caption: a request crosses into the process and is routed
    steps:
      - { verb: send, part: src, card: req }
      - { verb: cross, part: edge, card: req, via: call }
      - { verb: route, part: route, card: req, via: hop }
      - { verb: transform, part: parse, card: req, via: tasks, args: { to: Task } }
  - caption: one card in, a copy on each branch, joined again
    steps:
      - { verb: split, part: fan, card: req, via: shaped }
      - { verb: send, part: fan, card: c1, args: { branch: b1 } }
      - { verb: send, part: fan, card: c2, args: { branch: b2 }, with: true }
      - { verb: wait, part: join, card: c1, via: left }
      - { verb: join, part: join, card: c2, via: right }
      - { verb: release, part: join, card: both }
  - caption: many in, one out, through the stages
    steps:
      - { verb: record, part: sum, card: both, via: joined }
      - { verb: reduce, part: sum }
      - { verb: flush, part: sum, card: one }
      - { verb: stage, part: ci, card: one, via: summary }
      - { verb: stage, part: ci, card: one }
      - { verb: stage, part: ci, card: one }
      - { verb: finish, part: ci, card: one }
      - { verb: render, part: view, card: one, via: shipped }
`;

const POOL = `
version: 1
parts:
  - { id: jobs, kind: source }
  - { id: seats, kind: pool, props: { seats: 1 } }
  - { id: view, kind: client }
rails:
  - { id: submit, from: jobs.out, to: seats.in }
  - { id: done, from: seats.out, to: view.result }
cards:
  - { id: j1, token: request, label: job 1 }
  - { id: j2, token: request, label: job 2 }
story:
  - steps:
      - { verb: send, part: jobs, card: j1 }
      - { verb: spawn, part: seats, card: j1, via: submit }
      - { verb: send, part: jobs, card: j2 }
      - { verb: spawn, part: seats, card: j2, via: submit }
      - { verb: wait, part: seats }
      - { verb: release, part: seats, card: j1 }
      - { verb: render, part: view, card: j1, via: done }
      - { verb: release, part: seats, card: j2, args: { outcome: error } }
      - { verb: render, part: view, card: j2, via: done, args: { outcome: error } }
      - { verb: drain, part: seats }
      - { verb: close, part: seats }
`;

function compile(source: string) {
  const parsed = parseFlowSpec(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  expect(validateFlowSpec(parsed.value, createFlowRegistry())).toEqual([]);
  const result = compileFlow(parsed.value);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return arrangement(result.flow, "current")!;
}

const notes = (d: ReturnType<typeof compile>, id: string) =>
  d.parts.find((p) => p.id === id)!.timeline.notes.map((n) => n[1]);

describe("parts in a flow spec", () => {
  it("compiles a spec using every new part kind, and the card arrives at the end", () => {
    const d = compile(FAN_OUT_IN);
    expect(notes(d, "edge")).toContain("inside");
    expect(notes(d, "route")).toContain("→ /tasks");
    expect(notes(d, "parse")).toContain("Task out");
    expect(notes(d, "fan")).toContain("2 of 2 delivered");
    expect(notes(d, "join")).toEqual(
      expect.arrayContaining(["1 of 2 · waiting", "2 of 2", "joined"])
    );
    expect(notes(d, "sum")).toContain("one summary");
    expect(notes(d, "ci")).toEqual(
      expect.arrayContaining([
        "stage 1 · build",
        "stage 2 · test",
        "stage 3 · ship",
        "all stages passed",
      ])
    );
    expect(notes(d, "view")).toContain("rendered");
    expect(
      d.markers.some(
        (m) => m.kind === "arrival" && m.card === "one" && m.part === "view"
      )
    ).toBe(true);
  });

  it("a pool seats up to its size, queues the rest and frees seats in order", () => {
    const d = compile(POOL);
    expect(notes(d, "seats")).toEqual(
      expect.arrayContaining([
        "1 of 1 busy",
        "queue · 1 waiting",
        "seat freed",
        "job 2 failed",
        "0 of 1 busy",
      ])
    );
    expect(notes(d, "view")).toEqual(
      expect.arrayContaining(["rendered", "error shown"])
    );
  });

  it("routes an unmatched card to the 404 lane unless a fallback is set", () => {
    const spec = (fallback: boolean) => `
version: 1
parts:
  - { id: src, kind: source }
  - { id: r, kind: router, props: { fallback: ${fallback} } }
rails:
  - { id: in, from: src.out, to: r.in }
cards:
  - { id: q, token: request, label: /nope }
story:
  - steps:
      - { verb: send, part: src, card: q }
      - { verb: route, part: r, card: q, via: in }
`;
    expect(notes(compile(spec(false)), "r")).toContain("no route · 404");
    expect(notes(compile(spec(true)), "r")).toContain("no match → fallback");
  });
});

const MESSAGING = `
version: 1
parts:
  - { id: q, kind: queue, props: { slots: 2 } }
  - { id: rt, kind: retry }
  - { id: to, kind: timeout, props: { budget: 2 } }
  - { id: rl, kind: rate limiter, props: { tokens: 2 } }
  - { id: cb, kind: circuit breaker, props: { threshold: 2 } }
  - { id: g, kind: guard, props: { allow: [read], reason: read only } }
  - { id: ap, kind: approval }
  - { id: m, kind: metric }
  - { id: tr, kind: trace }
  - { id: al, kind: alert }
  - { id: er, kind: event rail }
cards:
  - { id: j1, token: request, label: job 1 }
  - { id: j2, token: request, label: job 2 }
  - { id: j3, token: request, label: job 3 }
  - { id: r1, token: request, label: retry job }
  - { id: t1, token: request, label: call }
  - { id: l1, token: request, label: req 1 }
  - { id: l2, token: request, label: req 2 }
  - { id: l3, token: request, label: req 3 }
  - { id: c1, token: request, label: call }
  - { id: g1, token: request, label: write }
  - { id: a1, token: request, label: deploy }
  - { id: s1, token: event, label: sample }
  - { id: e1, token: event, label: errors > 5 }
story:
  - caption: a queue takes two jobs, rejects a third, delivers one and sends one to the dead letter
    steps:
      - { verb: send, part: q, card: j1 }
      - { verb: send, part: q, card: j2 }
      - { verb: send, part: q, card: j3 }
      - { verb: drain, part: q, card: j1 }
      - { verb: fail, part: q, card: j2 }
  - caption: retry backs off then succeeds; a timeout answers; a bucket empties and a 429 follows
    steps:
      - { verb: send, part: rt, card: r1 }
      - { verb: wait, part: rt }
      - { verb: send, part: rt, card: r1, args: { outcome: ok } }
      - { verb: wait, part: to, card: t1 }
      - { verb: tick, part: to, args: { answer: true } }
      - { verb: send, part: rl, card: l1 }
      - { verb: send, part: rl, card: l2 }
      - { verb: fail, part: rl, card: l3 }
  - caption: a breaker opens and a trial closes it; a guard denies and a person approves
    steps:
      - { verb: fail, part: cb }
      - { verb: fail, part: cb }
      - { verb: send, part: cb, card: c1 }
      - { verb: trip, part: cb }
      - { verb: probe, part: cb }
      - { verb: reset, part: cb }
      - { verb: decide, part: g, card: g1, args: { subject: write } }
      - { verb: wait, part: ap, card: a1 }
      - { verb: approve, part: ap, card: a1 }
  - caption: samples count past the limit, spans nest, an alert pages and escalates
    steps:
      - { verb: measure, part: m, card: s1, args: { by: 30 } }
      - { verb: measure, part: m, args: { by: 30 } }
      - { verb: observe, part: m }
      - { verb: stage, part: tr, args: { name: request } }
      - { verb: span, part: tr, args: { name: query } }
      - { verb: finish, part: tr, args: { outcome: error } }
      - { verb: notify, part: al, card: e1 }
      - { verb: escalate, part: al }
      - { verb: send, part: er, args: { event: tool started, role: amber } }
      - { verb: wait, part: er }
      - { verb: resume, part: er, args: { from: 1 } }
`;

describe("messaging, policy and observability parts in a flow spec", () => {
  it("compiles a spec using every new part kind with the catalogue status lines", () => {
    const d = compile(MESSAGING);
    expect(notes(d, "q")).toEqual(
      expect.arrayContaining([
        "1 waiting",
        "2 waiting",
        "full · job 3 rejected",
        "job 1 delivered",
        "→ dead letter",
      ])
    );
    expect(notes(d, "rt")).toEqual(
      expect.arrayContaining([
        "attempt 1",
        "failed · backing off",
        "attempt 2",
        "ok on attempt 2",
      ])
    );
    expect(notes(d, "to")).toEqual(
      expect.arrayContaining(["waiting · 2 s budget", "answered in time"])
    );
    expect(notes(d, "rl")).toEqual(
      expect.arrayContaining(["1 tokens", "empty", "rejected · 429"])
    );
    expect(notes(d, "cb")).toEqual(
      expect.arrayContaining([
        "1 failure",
        "2 failures · open",
        "open · fail fast",
        "half-open · one trial",
        "trial ok · closed",
      ])
    );
    expect(notes(d, "g")).toContain("deny · read only");
    expect(notes(d, "ap")).toEqual(
      expect.arrayContaining(["waiting for a person", "approved"])
    );
    expect(notes(d, "m")).toEqual(
      expect.arrayContaining(["counting", "over limit"])
    );
    expect(notes(d, "tr")).toEqual(
      expect.arrayContaining(["recording", "slow · query failed"])
    );
    expect(notes(d, "al")).toEqual(
      expect.arrayContaining(["firing", "no ack · escalating"])
    );
    expect(notes(d, "er")).toEqual(
      expect.arrayContaining([
        "tool started",
        "disconnected",
        "reconnect · from #1",
        "caught up",
      ])
    );
  });

  it("a full queue rejects, and the rest of the queue moves forward when one is delivered", () => {
    const d = compile(MESSAGING);
    const q = d.parts.find((p) => p.id === "q")!;
    expect(
      q.timeline.cards.some((c) => c.tags.some((t) => t.text === "job 3"))
    ).toBe(true);
    expect(
      notes(d, "q").filter((n) => n === "full · job 3 rejected")
    ).toHaveLength(1);
  });
});
