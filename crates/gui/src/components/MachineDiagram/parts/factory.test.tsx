/**
 * factory station (catalogue v2.2 "factory"): prop-driven layout for 1–20
 * workflows and 0–6+ inbound and outbound factories, workflow-mark state
 * from TaskRun state (never from a factory or workflow name), the flow
 * kind's ports, stages and happy path against the gallery still, and no
 * animation frames at rest.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MachineDiagram } from "../MachineDiagram";
import { textBox } from "../flow/measure";
import { beatOutcome } from "../flow/clockModel";
import { arrangement, compileFlow } from "../flow/compile";
import { createFlowRegistry } from "../flow/defaults";
import { FlowDiagram } from "../flow/FlowDiagram";
import { parseFlowSpec } from "../flow/parse";
import { resolvePart } from "../flow/registry";
import { validateFlowSpec } from "../flow/validate";
import { factoryPart, factoryPortFor } from "../flow/parts/factory";
import { PartContext } from "../partContext";
import { CatalogPart } from "./index";
import {
  FactoryStation,
  factoryMachine,
  markDots,
  type FactoryExtra,
} from "./factory";
import {
  IN_LABEL_X,
  factoryLayout,
  factoryOutIndex,
  inIndex,
  inLabelRoom,
  litInLabel,
  litOutLabel,
  type FactoryLayout,
} from "./factorySpec";
import { LABEL_X, labelRoom } from "./workflowSpec";

afterEach(cleanup);

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const around = (x: number, y: number, rx: number, ry = rx): Box => ({
  x0: x - rx,
  y0: y - ry,
  x1: x + rx,
  y1: y + ry,
});

const WORKFLOW_COUNTS = [1, 2, 13, 20] as const;
const ROUTE_COUNTS = [0, 1, 4, 6, 9] as const;
const NAMES = [
  "Release",
  "Review",
  "Docs",
  "Deploy",
  "Triage",
  "Archive",
  "Intake",
  "Bugs",
  "Ops",
];
const workflowsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => 1 + ((i * 3) % 9));
const routesOf = (n: number) => NAMES.slice(0, n);

/** Every drawn element the layout places, as boxes in part space. */
function boxes(L: FactoryLayout, chipCount: number) {
  const frame = { x0: L.x0, y0: L.y0, x1: L.x1, y1: L.y0 + L.h };
  // The 32×22 mark box at its 1.08 pop.
  const marks = L.marks.map((m) => around(m.x, m.y, 16 * 1.08, 11 * 1.08));
  // The 28 px card docked 30 px under each mark.
  const docks = L.marks.map((m) => around(m.dock[0], m.dock[1], 14, 9));
  const chips = Array.from({ length: chipCount }, (_, i) =>
    around(L.chips.x - i * 20, L.chips.y, 7)
  );
  const gates = [
    ...L.ins.map((o) => around(L.x0, o.y, 5, 16)),
    ...L.outs.map((o) => around(L.x1, o.y, 5, 16)),
  ];
  const labels = [
    ...L.ins
      .filter((o) => o.label)
      .map((o) => textBox(IN_LABEL_X, o.y - 18, o.label, 18, "left")),
    ...L.outs.map((o) => textBox(LABEL_X, o.y - 18, o.label, 18, "right")),
  ];
  const status = textBox(
    L.status.x,
    L.status.y,
    "workflow 6/13 waiting · gate · 3 parked",
    20,
    "center"
  );
  return { frame, marks, docks, chips, gates, labels, status };
}

describe("prop resolution (catalogue layout rules)", () => {
  it("reproduces the gallery frame for every scenario's props", () => {
    const expected = [
      [206, 112, 228, 150],
      [206, 112, 228, 150],
      [124, 112, 392, 214],
      [124, 112, 392, 214],
    ];
    factoryMachine.scenarios.forEach((sc, i) => {
      expect(sc.bb).toEqual(expected[i]);
      expect(sc.status).toEqual({
        x: 320,
        y: Math.min(expected[i][1] + expected[i][3] + 40, 346),
      });
    });
  });

  it.each(
    WORKFLOW_COUNTS.flatMap((n) =>
      ROUTE_COUNTS.flatMap((i) => ROUTE_COUNTS.map((o) => [n, i, o]))
    )
  )(
    "%i workflows, %i inbound, %i outbound lay out without overlaps",
    (n, i, o) => {
      const L = factoryLayout(workflowsOf(n), routesOf(i), routesOf(o));
      const b = boxes(L, 8);
      // Marks per row: all up to seven, else two rows; 44 px apart, rows 64 px apart.
      const per = n > 7 ? Math.ceil(n / 2) : n;
      expect(L.per).toBe(per);
      expect(new Set(L.marks.map((m) => m.y)).size).toBe(Math.ceil(n / per));
      expect(L.w).toBe(Math.max(228, per * 44 + 84));
      expect(L.x0 + L.w / 2).toBeCloseTo(320, 0);
      expect(L.y0).toBe(112);
      const ports = Math.max(Math.min(i, 4), Math.min(o, 4), 1);
      expect(L.h).toBe(
        Math.max(150 + 64 * (L.rows - 1), 60 + (ports - 1) * 44)
      );
      L.marks.forEach((m, k) => {
        if (k % per) expect(m.x - L.marks[k - 1].x).toBe(44);
        expect(m.dock).toEqual([m.x, m.y + 30]);
      });
      // Marks and docks inside the frame and clear of each other.
      const inside = [...b.marks, ...b.docks];
      for (const box of inside) {
        expect(box.x0).toBeGreaterThanOrEqual(b.frame.x0);
        expect(box.x1).toBeLessThanOrEqual(b.frame.x1);
        expect(box.y0).toBeGreaterThanOrEqual(b.frame.y0);
        expect(box.y1).toBeLessThanOrEqual(b.frame.y1);
      }
      inside.forEach((a, k) =>
        inside.slice(k + 1).forEach((c) => expect(overlaps(a, c)).toBe(false))
      );
      // The turns stay clear of the marks they route around.
      for (const m of b.marks) {
        expect(m.x0).toBeGreaterThan(L.inTurn);
        expect(m.x1).toBeLessThan(L.turn);
      }
      // At most four ports a side; none inbound gives one unlabelled entry.
      expect(L.ins.map((p) => p.port)).toEqual(
        i ? routesOf(Math.min(i, 4)).map((_, j) => `in${j + 1}`) : ["in"]
      );
      expect(L.outs.map((p) => p.port)).toEqual(
        routesOf(Math.min(o, 4)).map((_, j) => `out${j + 1}`)
      );
      for (const side of [L.ins, L.outs])
        side.forEach((p) => {
          if (side.length > 1) {
            expect(p.y).toBeGreaterThanOrEqual(L.y0 + 30);
            expect(p.y).toBeLessThanOrEqual(L.y0 + L.h - 30);
          } else expect(p.y).toBe(L.ty);
        });
      // Chips, gates and labels: inside the canvas, clear of each other and of the frame.
      const outside = [...b.chips, ...b.gates, ...b.labels];
      outside.forEach((a, k) =>
        outside.slice(k + 1).forEach((c) => expect(overlaps(a, c)).toBe(false))
      );
      for (const box of [...b.chips, ...b.labels]) {
        expect(overlaps(box, b.frame)).toBe(false);
        expect(box.x0).toBeGreaterThanOrEqual(0);
        expect(box.x1).toBeLessThanOrEqual(640);
        expect(box.y0).toBeGreaterThanOrEqual(0);
      }
      // A bundle's lit label fits the same room.
      const lit = [
        textBox(IN_LABEL_X, 0, litInLabel(L, "Archive"), 18, "left"),
        textBox(LABEL_X, 0, litOutLabel(L, "Archive"), 18, "right"),
      ];
      expect(lit[0].x1).toBeLessThanOrEqual(IN_LABEL_X + inLabelRoom(L.x0) + 1);
      expect(lit[1].x0).toBeGreaterThanOrEqual(LABEL_X - labelRoom(L.x1) - 1);
      // The status line sits under the frame, inside the 400 px canvas.
      expect(b.status.y0).toBeGreaterThan(b.frame.y1);
      expect(b.status.y1).toBeLessThanOrEqual(400);
      // One stage per workflow mark, uniquely named, not overlapping.
      expect(L.stages.map((s) => s.name)).toEqual(
        L.marks.map((_, k) => `workflow ${k + 1}`)
      );
      const st = L.stages.map(({ bb: [x, y, w, h] }) => ({
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
      }));
      st.forEach((a, k) =>
        st.slice(k + 1).forEach((c) => expect(overlaps(a, c)).toBe(false))
      );
    }
  );

  it("bundles every factory past three into port 4 on each side, labelled +k more", () => {
    const six = routesOf(6);
    const L = factoryLayout(workflowsOf(13), six, six);
    for (const side of [L.ins, L.outs]) {
      expect(side.map((p) => p.label)).toEqual([
        "Release",
        "Review",
        "Docs",
        "+3 more",
      ]);
      expect(side[3].targets).toEqual(["Deploy", "Triage", "Archive"]);
      expect(side[3].bundle).toBe(true);
    }
    const props = { workflows: workflowsOf(13), inbound: six, outbound: six };
    expect(six.map((f) => factoryPortFor(props, f))).toEqual([
      "out1",
      "out2",
      "out3",
      "out4",
      "out4",
      "out4",
    ]);
    expect(six.map((f) => factoryPortFor(props, f, "in"))).toEqual([
      "in1",
      "in2",
      "in3",
      "in4",
      "in4",
      "in4",
    ]);
    expect(factoryPortFor(props, "Nowhere")).toBeNull();
    expect(factoryPortFor(props, "Nowhere", "in")).toBeNull();
    expect(inIndex(L, "Archive")).toBe(3);
    expect(factoryOutIndex(L, "Deploy")).toBe(3);
    // Exactly four: no bundle.
    const four = factoryLayout([3], routesOf(4), routesOf(4));
    expect(four.outs.map((p) => p.label)).toEqual(routesOf(4));
    expect([...four.ins, ...four.outs].some((p) => p.bundle)).toBe(false);
  });

  it("resolves the flow kind's ports, frame, status and stages from props", () => {
    for (const n of WORKFLOW_COUNTS)
      for (const k of ROUTE_COUNTS) {
        const props = {
          workflows: workflowsOf(n),
          inbound: routesOf(k),
          outbound: routesOf(k),
          parked: 0,
          active: 0,
        };
        const L = factoryLayout(props.workflows, props.inbound, props.outbound);
        const def = resolvePart(factoryPart, props);
        expect(def.bb).toEqual(L.bb);
        expect(def.status).toEqual(L.status);
        expect(Object.keys(def.ports)).toEqual([
          ...L.ins.map((p) => p.port),
          ...L.outs.map((p) => p.port),
        ]);
        L.ins.forEach((p) =>
          expect(def.ports[p.port]).toMatchObject({
            side: "W",
            x: L.x0,
            y: p.y,
            direction: "in",
          })
        );
        L.outs.forEach((p) =>
          expect(def.ports[p.port]).toMatchObject({
            side: "E",
            x: L.x1,
            y: p.y,
            direction: "out",
          })
        );
        // Every route resolves to a drawn port; no finished or needs-attention exits.
        for (const f of props.inbound)
          expect(def.ports[factoryPortFor(props, f, "in")!]).toBeDefined();
        for (const f of props.outbound)
          expect(def.ports[factoryPortFor(props, f)!]).toBeDefined();
        expect(
          Object.keys(def.ports).filter((p) => !/^(in|out)\d?$/.test(p))
        ).toEqual([]);
        expect(def.gates!(props)).toHaveLength(L.ins.length + L.outs.length);
        expect(factoryPart.stages!(props)).toEqual(L.stages);
      }
  });

  it("rejects bad props: workflow count, step counts, duplicate factories", () => {
    const registry = createFlowRegistry();
    const errors = (props: string) => {
      const parsed = parseFlowSpec(`
version: 1
parts:
  - { id: f, kind: factory, props: ${props} }
story: []
`);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed));
      return validateFlowSpec(parsed.value, registry).map((e) => e.path);
    };
    expect(errors("{ workflows: [] }")).toEqual(["parts[0].props.workflows"]);
    expect(errors(`{ workflows: [${workflowsOf(21).join(", ")}] }`)).toEqual([
      "parts[0].props.workflows",
    ]);
    expect(errors("{ workflows: [3, 0] }")).toEqual([
      "parts[0].props.workflows[1]",
    ]);
    expect(errors("{ workflows: [3, 2.5] }")).toEqual([
      "parts[0].props.workflows",
    ]);
    expect(errors("{ workflows: [3], outbound: [A, A] }")).toEqual([
      "parts[0].props.outbound",
    ]);
    expect(errors("{ workflows: [3], inbound: [A, A] }")).toEqual([
      "parts[0].props.inbound",
    ]);
    expect(
      errors(
        `{ workflows: [${workflowsOf(20).join(", ")}], inbound: [${routesOf(9).join(", ")}], outbound: [${routesOf(9).join(", ")}] }`
      )
    ).toEqual([]);
  });
});

/* ---------- workflow marks ---------- */

function extraFor(
  workflows: readonly number[],
  marks: FactoryExtra["marks"] = workflows.map(() => [[0, "off"]]),
  bursts: FactoryExtra["bursts"] = []
): FactoryExtra {
  const layout = factoryLayout(workflows, [], []);
  return {
    workflows,
    inbound: [],
    outbound: [],
    layout,
    marks,
    chips: [],
    ins: layout.ins.map(() => []),
    outs: [],
    bursts,
  };
}

function marksAt(extra: FactoryExtra, t: number) {
  const { container, unmount } = render(
    <svg>
      <PartContext.Provider
        value={{ fade: 1, removed: false, labels: true, hatchId: "h" }}
      >
        <FactoryStation t={t} x={extra} />
      </PartContext.Provider>
    </svg>
  );
  const out = [...container.querySelectorAll(".md-workflow-mark")].map((g) => ({
    state: g.getAttribute("data-state"),
    outline: g.querySelector(".md-mark-box")!.getAttribute("stroke"),
    dots: [...g.querySelectorAll(".md-mark-dot")].map((d) =>
      d.getAttribute("data-role")
    ),
    ring: g.querySelector(".md-mark-ring")?.getAttribute("stroke") ?? null,
  }));
  const bursts = [...container.querySelectorAll(".md-burst")].map((b) =>
    b.getAttribute("stroke")
  );
  unmount();
  return { out, bursts };
}

describe("workflow marks: state on the outline, one dot per step", () => {
  it("the dot count follows the workflow's step count, up to five", () => {
    const { out } = marksAt(extraFor([1, 3, 5, 9, 20]), 0);
    expect(out.map((m) => m.dots.length)).toEqual([1, 3, 5, 5, 5]);
  });

  it("outline and dots follow TaskRun state", () => {
    const extra = extraFor(
      [4, 4, 4, 4, 4],
      [
        [[0, "off"]],
        [
          [0, "off"],
          [1, "run"],
        ],
        [
          [0, "off"],
          [1, "park"],
        ],
        [
          [0, "off"],
          [0.5, "ok"],
        ],
        [
          [0, "off"],
          [1, "fail"],
        ],
      ],
      [[4, 1, "red"]]
    );
    const { out, bursts } = marksAt(extra, 1.1);
    expect(out[0]).toEqual({
      state: "off",
      outline: "var(--md-edge)",
      dots: ["edge", "edge", "edge", "edge"],
      ring: null,
    });
    // Working: ink outline, the dots light amber in order (5 per second).
    expect(out[1]).toEqual({
      state: "run",
      outline: "var(--md-ink)",
      dots: ["amber", "edge", "edge", "edge"],
      ring: null,
    });
    expect(marksAt(extra, 1.3).out[1].dots).toEqual([
      "edge",
      "amber",
      "edge",
      "edge",
    ]);
    expect(marksAt(extra, 1.65).out[1].dots).toEqual([
      "edge",
      "edge",
      "edge",
      "amber",
    ]);
    expect(marksAt(extra, 1.85).out[1].dots).toEqual([
      "amber",
      "edge",
      "edge",
      "edge",
    ]);
    // Parked: amber outline plus a still amber ring, grey dots.
    expect(out[2]).toEqual({
      state: "park",
      outline: "var(--md-amber)",
      dots: ["edge", "edge", "edge", "edge"],
      ring: "var(--md-amber)",
    });
    expect(marksAt(extra, 3).out[2].ring).toBe("var(--md-amber)");
    // Completed: green outline and dots.
    expect(out[3]).toEqual({
      state: "ok",
      outline: "var(--md-green)",
      dots: ["green", "green", "green", "green"],
      ring: null,
    });
    // Failed: red outline, the last dot red, a red burst.
    expect(out[4]).toEqual({
      state: "fail",
      outline: "var(--md-red)",
      dots: ["edge", "edge", "edge", "red"],
      ring: null,
    });
    expect(bursts).toEqual(["var(--md-red)"]);
    expect(markDots(1, "run", 0, 0.9)).toEqual(["amber"]);
  });

  it("nothing is chosen from a factory or workflow name", () => {
    const source = (label: string, ins: string, outs: string, card: string) => `
version: 1
parts:
  - { id: f, kind: factory, label: ${label}, scale: 1, props: { workflows: [3, 5, 2], inbound: [${ins}], outbound: [${outs}] } }
cards:
  - { id: t, token: payload, label: ${card} }
story:
  - steps:
      - { verb: enter, part: f, card: t }
      - { verb: step, part: f }
      - { verb: wait, part: f }
`;
    const picture = (src: string) => {
      const d = compile(src);
      const p = d.parts[0];
      const { container, unmount } = render(
        <FlowDiagram diagram={d} t={p.steps.at(-1)!.end} reducedMotion />
      );
      const part = container.querySelector("[data-part-id='f']")!;
      const out = {
        marks: [...part.querySelectorAll(".md-workflow-mark")].map(
          (g) => g.outerHTML
        ),
        chips: [...part.querySelectorAll(".md-chip")].map((c) =>
          c.getAttribute("data-role")
        ),
        notes: p.timeline.notes.map((n) => [n[0], n[2]]),
      };
      unmount();
      return out;
    };
    const plain = picture(source("PR Review", "Intake", "Release", "task"));
    expect(plain.marks).toHaveLength(3);
    // Names that read like states or other factories change nothing.
    expect(picture(source("Failed", "Release", "Intake", "failed"))).toEqual(
      plain
    );
    expect(picture(source("Done", "Bugs", "Archive", "done"))).toEqual(plain);
  });
});

/* ---------- flow ---------- */

function compile(source: string) {
  const parsed = parseFlowSpec(source);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed));
  expect(validateFlowSpec(parsed.value, createFlowRegistry())).toEqual([]);
  const result = compileFlow(parsed.value);
  if (!result.ok) throw new Error(JSON.stringify(result.errors));
  return arrangement(result.flow, "current")!;
}

const HAPPY = `
version: 1
parts:
  - { id: f, kind: factory, scale: 1, props: { workflows: [3, 5] } }
cards:
  - { id: t, token: payload, label: task }
story:
  - caption: the task enters and workflow 1 works
    steps:
      - { verb: enter, part: f, card: t }
  - caption: workflow 1 completes and workflow 2 works
    steps:
      - { verb: step, part: f }
  - caption: the task finishes at workflow 2
    steps:
      - { verb: finish, part: f }
`;

/** The mechanism a picture shows: mark states, dot counts, chips, lit ports. */
function mechanism(root: Element) {
  return {
    marks: [...root.querySelectorAll(".md-workflow-mark")].map((g) => [
      g.getAttribute("data-state"),
      g.querySelectorAll(".md-mark-dot").length,
    ]),
    chips: [...root.querySelectorAll(".md-chip")].map((c) =>
      c.getAttribute("data-role")
    ),
    lit: [...root.querySelectorAll("[data-lit]")].map((p) =>
      p.getAttribute("data-port")
    ),
  };
}

function galleryAt(index: number, t: number) {
  const { container, unmount } = render(
    <MachineDiagram label="factory">
      <CatalogPart
        def={factoryMachine as never}
        view={{ kind: "scenario", index, t }}
        reducedMotion={false}
      />
    </MachineDiagram>
  );
  const m = mechanism(container.querySelector("[data-part='factory']")!);
  unmount();
  return m;
}

describe("the factory flow kind", () => {
  it("is registered and a ```flow block using it renders its mechanism", () => {
    const d = compile(HAPPY);
    const p = d.parts[0];
    expect(p.kind).toBe("factory");
    const { container } = render(
      <FlowDiagram diagram={d} t={beatOutcome(p.timeline, 1)} reducedMotion />
    );
    const part = container.querySelector("[data-part-id='f']")!;
    expect(part).not.toBeNull();
    expect(part.querySelectorAll(".md-workflow-mark")).toHaveLength(2);
    expect(part.querySelector(".md-box")).not.toBeNull();
    // No standalone gallery rails inside flows.
    expect(part.querySelectorAll(".md-rail")).toHaveLength(0);
  });

  it("the happy path reproduces the gallery's enters-and-finishes scenario at the beat outcomes", () => {
    const d = compile(HAPPY);
    const tl = d.parts[0].timeline;
    const flowAt = (beat: number) => {
      const { container, unmount } = render(
        <FlowDiagram diagram={d} t={beatOutcome(tl, beat)} reducedMotion />
      );
      const m = mechanism(container.querySelector("[data-part-id='f']")!);
      unmount();
      return m;
    };
    // The still (2.8 s): workflow 1 done, workflow 2 working, one active task.
    const still = galleryAt(0, factoryMachine.scenarios[0].still);
    expect(still).toEqual({
      marks: [
        ["ok", 3],
        ["run", 5],
      ],
      chips: ["ink"],
      lit: [],
    });
    expect(flowAt(1)).toEqual(still);
    // Workflow 1 working (gallery 1.5 s) and the finish (gallery 3.3 s, after the burst).
    expect(flowAt(0).marks).toEqual(galleryAt(0, 1.5).marks);
    expect(flowAt(2).marks).toEqual(galleryAt(0, 3.3).marks);
    expect(flowAt(2).chips).toEqual([]);
    // Same status vocabulary as the gallery scenario.
    expect(tl.notes.map((n) => n[1])).toEqual(
      expect.arrayContaining([
        "task enters",
        "workflow 1/2",
        "workflow 2/2",
        "finish · task done",
      ])
    );
  });

  it("enters from an inbound factory's port, parks a workflow and resumes", () => {
    const d = compile(`
version: 1
parts:
  - { id: f, kind: factory, scale: 1, props: { workflows: [4, 6, 3], inbound: [Intake, Bugs], parked: 2 } }
cards:
  - { id: t, token: payload, label: task }
story:
  - steps:
      - { verb: enter, part: f, card: t, args: { from: Bugs } }
      - { verb: step, part: f }
      - { verb: wait, part: f }
      - { verb: step, part: f }
`);
    const p = d.parts[0];
    const enter = p.steps[0];
    const at = (t: number) => {
      const { container, unmount } = render(
        <FlowDiagram diagram={d} t={t} reducedMotion={false} />
      );
      const part = container.querySelector("[data-part-id='f']")!;
      const m = mechanism(part);
      const label = part.querySelector("[data-lit]")?.textContent ?? null;
      unmount();
      return { ...m, label };
    };
    expect(at(enter.t + 0.3)).toMatchObject({ lit: ["in2"], label: "Bugs" });
    const wait = p.steps[2];
    expect(at(wait.end - 0.05)).toMatchObject({
      marks: [
        ["ok", 4],
        ["park", 5],
        ["off", 3],
      ],
      chips: ["amber", "amber", "amber"],
    });
    expect(at(p.steps[3].end)).toMatchObject({
      marks: [
        ["ok", 4],
        ["ok", 5],
        ["run", 3],
      ],
      chips: ["amber", "amber", "ink"],
    });
    expect(p.timeline.notes.map((n) => n[1])).toEqual(
      expect.arrayContaining([
        "task enters from Bugs",
        "workflow 2/3 waiting · gate · 3 parked",
        "answered · workflow 2/3",
        "workflow 3/3",
      ])
    );
  });

  it("a hand-off leaves by its factory's port; a bundled one lights the bundle port with its target", () => {
    const d = compile(`
version: 1
parts:
  - { id: f, kind: factory, scale: 1, props: { workflows: [4, 6], inbound: [Intake], outbound: [Release, Review, Docs, Deploy, Triage, Archive] } }
  - { id: next, kind: factory, props: { workflows: [3], inbound: [Upstream] } }
rails:
  - { id: out, from: f.out4, to: next.in1 }
cards:
  - { id: t, token: payload, label: task }
story:
  - caption: workflows run
    steps:
      - { verb: enter, part: f, card: t }
      - { verb: step, part: f }
  - caption: handed off to Deploy by the bundle port
    steps:
      - { verb: hand off, part: f, card: t, args: { to: Deploy } }
      - { verb: enter, part: next, card: t, via: out }
`);
    const f = d.parts.find((p) => p.id === "f")!;
    const at = f.steps.find((s) => s.verb === "hand off")!;
    expect(at.outcome.exit).toBe("out4");
    const { container } = render(
      <FlowDiagram diagram={d} t={at.t + 0.4} reducedMotion={false} />
    );
    const part = container.querySelector("[data-part-id='f']")!;
    const lit = part.querySelector("[data-lit]")!;
    expect(lit.getAttribute("data-port")).toBe("out4");
    expect(lit.textContent).toBe("→ Deploy");
    expect(f.timeline.notes.map((n) => n[1])).toContain("handed off → Deploy");
    // The entry it arrived on names the downstream factory's port.
    const next = d.parts.find((p) => p.id === "next")!;
    expect(next.timeline.notes.map((n) => n[1])).toContain(
      "task enters from Upstream"
    );
  });

  it("a failure stops at its mark: red mark, red card and chip, needs attention, nothing leaves", () => {
    const d = compile(`
version: 1
parts:
  - { id: f, kind: factory, scale: 1, props: { workflows: [4, 6], outbound: [Release] } }
cards:
  - { id: t, token: payload, label: task }
story:
  - steps:
      - { verb: enter, part: f, card: t }
      - { verb: step, part: f }
      - { verb: fail, part: f, args: { reason: step failed } }
`);
    const p = d.parts[0];
    const t = p.steps.at(-1)!.end - 0.05;
    const { container } = render(
      <FlowDiagram diagram={d} t={t} reducedMotion={false} />
    );
    const m = mechanism(container.querySelector("[data-part-id='f']")!);
    expect(m.marks.map((x) => x[0])).toEqual(["ok", "fail"]);
    expect(m.chips).toEqual(["red"]);
    expect(m.lit).toEqual([]);
    expect(p.steps.every((s) => s.outcome.exit === undefined)).toBe(true);
    expect(p.timeline.notes.map((n) => n[1])).toContain(
      "failed in workflow 2/2 · needs attention"
    );
  });
});

describe("performance at rest", () => {
  it("a flow of eight factory stations at rest schedules no animation frames", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { MarkdownContent } = await import("../../shared/MarkdownContent");
    const parts = Array.from(
      { length: 8 },
      (_, i) =>
        `  - { id: f${i}, kind: factory, props: { workflows: [${i % 2 ? "4, 6, 3, 9, 5, 2, 7, 4, 3, 6, 5, 8, 3" : "3, 5"}], inbound: [Prev], outbound: [Next] } }`
    ).join("\n");
    const rails = Array.from(
      { length: 7 },
      (_, i) => `  - { id: r${i}, from: f${i}.out1, to: f${i + 1}.in1 }`
    ).join("\n");
    const spec = `version: 1\nparts:\n${parts}\nrails:\n${rails}\ncards:\n  - { id: c, token: payload, label: task }\nstory:\n  - steps:\n      - { verb: enter, part: f0, card: c }\n      - { verb: hand off, part: f0, card: c, args: { to: Next } }\n      - { verb: enter, part: f1, card: c, via: r0 }\n`;
    raf.mockClear();
    const view = render(
      <MarkdownContent text={`\`\`\`flow\n${spec}\n\`\`\`\n`} />
    );
    await waitFor(
      () =>
        expect(
          view.container.querySelectorAll("[data-part='factory']")
        ).toHaveLength(8),
      { timeout: 10000 }
    );
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });
});
