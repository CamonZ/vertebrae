/**
 * workflow station (catalogue v2.2 "workflow"): prop-driven layout for 1–20
 * steps and any number of outgoing transitions, lamp colours by step type
 * (never by name) with state on the rim, the flow kind's ports, stages and
 * happy path against the gallery still, and no animation frames at rest.
 */
import { cleanup, render, waitFor } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
import { workflowPart, workflowPortFor } from "../flow/parts/workflow";
import { PartContext } from "../partContext";
import { STEP_HUE_ROLES } from "../palette";
import { CatalogPart } from "./index";
import {
  WorkflowStation,
  lampStateAt,
  workflowMachine,
  type WorkflowExtra,
} from "./workflow";
import {
  LABEL_X,
  STEP_HUE,
  WORKFLOW_STEP_TYPES,
  outIndex,
  workflowLayout,
  type WorkflowLayout,
} from "./workflowSpec";

afterEach(cleanup);

type Box = { x0: number; y0: number; x1: number; y1: number };
const overlaps = (a: Box, b: Box) =>
  a.x0 < b.x1 && b.x0 < a.x1 && a.y0 < b.y1 && b.y0 < a.y1;
const around = (x: number, y: number, r: number): Box => ({
  x0: x - r,
  y0: y - r,
  x1: x + r,
  y1: y + r,
});

const STEP_COUNTS = [1, 6, 20] as const;
const TRANSITION_COUNTS = [0, 1, 4, 6, 9] as const;
const stepsOf = (n: number) =>
  Array.from({ length: n }, (_, i) => WORKFLOW_STEP_TYPES[i % 8]);
const targetsOf = (n: number) =>
  [
    "review",
    "docs",
    "release",
    "rework",
    "triage",
    "archive",
    "plan",
    "qa",
    "ship",
  ].slice(0, n);

/** Every drawn element the layout places, as boxes in part space. */
function boxes(L: WorkflowLayout, chipCount: number) {
  const frame = { x0: L.x0, y0: L.y0, x1: L.x1, y1: L.y0 + L.h };
  // The rim (ring 13, spinner 14 with its 3.5 px stroke) and the type mark 26 px under it.
  const lamps = L.lamps.map((l) => around(l.x, l.y, 15.75));
  const marks = L.lamps.map((l) => ({
    x0: l.x - 9,
    y0: l.y + 26 - 7,
    x1: l.x + 9,
    y1: l.y + 26 + 7,
  }));
  const chips = Array.from({ length: chipCount }, (_, i) =>
    around(L.chips.x - i * 20, L.chips.y, 7)
  );
  // Closed pill gates on the out ports (11 px off the rail, 4.5 px half-height pills).
  const gates = L.outs.map((o) => ({
    x0: L.x1 - 5,
    y0: o.y - 16,
    x1: L.x1 + 5,
    y1: o.y + 16,
  }));
  const labels = L.outs.map((o) =>
    textBox(LABEL_X, o.y - 18, o.label, 18, "right")
  );
  const status = textBox(
    L.status.x,
    L.status.y,
    "steps 1–20 · executing",
    20,
    "center"
  );
  return { frame, lamps, marks, chips, gates, labels, status };
}

describe("prop resolution (catalogue layout rules)", () => {
  it("reproduces the gallery frame for every scenario's props", () => {
    const expected = [
      [206, 112, 228, 150],
      [206, 112, 228, 150],
      [128, 112, 384, 150],
      [128, 112, 384, 150],
      [200, 112, 240, 192],
    ];
    workflowMachine.scenarios.forEach((sc, i) => {
      expect(sc.bb).toEqual(expected[i]);
      expect(sc.status).toEqual({
        x: 320,
        y: Math.min(expected[i][1] + expected[i][3] + 40, 346),
      });
    });
  });

  it.each(STEP_COUNTS.flatMap((n) => TRANSITION_COUNTS.map((k) => [n, k])))(
    "%i steps, %i transitions lay out without overlaps",
    (n, k) => {
      const L = workflowLayout(stepsOf(n), targetsOf(k));
      const b = boxes(L, 8);
      // Lamps per row: all up to 10, else two rows; 56 px spacing up to four, else 36.
      const per = n > 10 ? Math.ceil(n / 2) : n;
      expect(L.spacing).toBe(per <= 4 ? 56 : 36);
      expect(L.w).toBe(Math.max(228, per * L.spacing + 60));
      expect(L.x0 + L.w / 2).toBeCloseTo(320, 0);
      expect(L.y0).toBe(112);
      expect(L.ty).toBe(L.y0 + L.h - 40);
      expect(new Set(L.lamps.map((l) => l.y)).size).toBe(Math.ceil(n / per));
      // Lamps, marks and the track sit inside the frame and clear of each other.
      for (const box of [...b.lamps, ...b.marks]) {
        expect(box.x0).toBeGreaterThanOrEqual(b.frame.x0);
        expect(box.x1).toBeLessThanOrEqual(b.frame.x1);
        expect(box.y0).toBeGreaterThanOrEqual(b.frame.y0);
        expect(box.y1).toBeLessThan(L.ty);
      }
      const inside = [...b.lamps, ...b.marks];
      inside.forEach((a, i) =>
        inside.slice(i + 1).forEach((c) => expect(overlaps(a, c)).toBe(false))
      );
      // At most four ports; spread top + 30 … bottom − 30, never closer than 32 px.
      expect(L.outs.length).toBe(Math.min(k, 4));
      L.outs.forEach((o, j) => {
        expect(o.port).toBe(`out${j + 1}`);
        if (L.outs.length > 1) {
          expect(o.y).toBeGreaterThanOrEqual(L.y0 + 30);
          expect(o.y).toBeLessThanOrEqual(L.y0 + L.h - 30);
        } else expect(o.y).toBe(L.ty);
      });
      // Chips, gates and labels: inside the canvas, clear of each other and of the frame.
      const outside = [...b.chips, ...b.gates, ...b.labels];
      outside.forEach((a, i) =>
        outside.slice(i + 1).forEach((c) => expect(overlaps(a, c)).toBe(false))
      );
      for (const box of [...b.chips, ...b.labels]) {
        expect(overlaps(box, b.frame)).toBe(false);
        expect(box.x0).toBeGreaterThanOrEqual(0);
        expect(box.x1).toBeLessThanOrEqual(640);
        expect(box.y0).toBeGreaterThanOrEqual(0);
      }
      // The status line sits under the frame, inside the 400 px canvas.
      expect(b.status.y0).toBeGreaterThan(b.frame.y1);
      expect(b.status.y1).toBeLessThanOrEqual(400);
      // One stage per lamp, uniquely named, not overlapping.
      expect(L.stages.map((s) => s.name)).toEqual(
        L.lamps.map((_, i) => `step ${i + 1}`)
      );
      const st = L.stages.map(({ bb: [x, y, w, h] }) => ({
        x0: x,
        y0: y,
        x1: x + w,
        y1: y + h,
      }));
      st.forEach((a, i) =>
        st.slice(i + 1).forEach((c) => expect(overlaps(a, c)).toBe(false))
      );
    }
  );

  it("bundles every transition past three into port 4, labelled +k more", () => {
    const six = targetsOf(6);
    const L = workflowLayout(stepsOf(5), six);
    expect(L.outs.map((o) => o.label)).toEqual([
      "review",
      "docs",
      "release",
      "+3 more",
    ]);
    expect(L.outs[3].targets).toEqual(["rework", "triage", "archive"]);
    expect(L.outs[3].bundle).toBe(true);
    const props = { steps: stepsOf(5), transitions: six };
    expect(six.map((t) => workflowPortFor(props, t))).toEqual([
      "out1",
      "out2",
      "out3",
      "out4",
      "out4",
      "out4",
    ]);
    expect(workflowPortFor(props, "nowhere")).toBeNull();
    // Exactly four: no bundle.
    const four = workflowLayout(stepsOf(5), targetsOf(4));
    expect(four.outs.map((o) => o.label)).toEqual(targetsOf(4));
    expect(four.outs.some((o) => o.bundle)).toBe(false);
  });

  it("resolves the flow kind's ports, frame, status and stages from props", () => {
    for (const n of STEP_COUNTS)
      for (const k of TRANSITION_COUNTS) {
        const props = {
          steps: stepsOf(n),
          transitions: targetsOf(k),
          parked: 0,
          active: 0,
        };
        const L = workflowLayout(props.steps, props.transitions);
        const def = resolvePart(workflowPart, props);
        expect(def.bb).toEqual(L.bb);
        expect(def.status).toEqual(L.status);
        expect(Object.keys(def.ports)).toEqual([
          "in",
          ...L.outs.map((o) => o.port),
        ]);
        expect(def.ports.in).toMatchObject({ side: "W", x: L.x0, y: L.ty });
        L.outs.forEach((o) =>
          expect(def.ports[o.port]).toMatchObject({
            side: "E",
            x: L.x1,
            y: o.y,
          })
        );
        // Every transition resolves to a drawn port.
        for (const t of props.transitions)
          expect(def.ports[workflowPortFor(props, t)!]).toBeDefined();
        expect(def.gates!(props)).toHaveLength(1 + L.outs.length);
        expect(workflowPart.stages!(props)).toEqual(L.stages);
      }
  });

  it("rejects bad props: step count, non-step types, duplicate targets", () => {
    const check = (p: Record<string, unknown>) =>
      workflowPart.checkProps!({
        parked: 0,
        active: 0,
        transitions: [],
        ...p,
      } as never).map((e) => e.path);
    expect(check({ steps: [] })).toEqual(["steps"]);
    expect(check({ steps: stepsOf(21) })).toEqual(["steps"]);
    expect(check({ steps: ["plan", "execute"] })).toEqual(["steps[0]"]);
    expect(check({ steps: ["execute"], transitions: ["a", "a"] })).toEqual([
      "transitions",
    ]);
    expect(check({ steps: stepsOf(20), transitions: targetsOf(9) })).toEqual(
      []
    );
  });
});

/* ---------- lamps ---------- */

const ALL_TYPES = [...WORKFLOW_STEP_TYPES];

function extraFor(
  steps: readonly string[],
  lamps: WorkflowExtra["lamps"] = steps.map(() => [[0, "off"]])
): WorkflowExtra {
  const layout = workflowLayout(steps, []);
  return {
    steps,
    transitions: [],
    layout,
    lamps,
    chips: [],
    ports: [],
    bursts: [],
  };
}

function station(extra: WorkflowExtra, t: number) {
  return render(
    <svg>
      <PartContext.Provider
        value={{ fade: 1, removed: false, labels: true, hatchId: "h" }}
      >
        <WorkflowStation t={t} x={extra} />
      </PartContext.Provider>
    </svg>
  );
}

describe("lamp colours: core by step type, state on the rim", () => {
  it("each core resolves to its step type's Hearth token (execute → --color-fg-soft)", () => {
    const { container } = station(extraFor(ALL_TYPES), 0);
    const cores = [...container.querySelectorAll(".md-step-lamp")].map((g) => [
      g.getAttribute("data-step-type"),
      g.querySelector(".md-step-core")!.getAttribute("fill"),
    ]);
    expect(cores).toEqual(
      ALL_TYPES.map((t) => [t, `var(--md-${STEP_HUE[t]})`])
    );
    // The roles map onto the app's step tokens in MachineDiagram.css.
    const css = readFileSync(
      resolve(__dirname, "../MachineDiagram.css"),
      "utf8"
    );
    const token: Record<string, string> = {
      "step-llm": "--color-step-llm",
      "step-structured": "--color-step-structured",
      "step-execute": "--color-fg-soft",
      "step-route": "--color-step-route",
      "step-human": "--color-step-human",
      "step-wait": "--color-step-wait",
      "step-stop": "--color-step-stop",
      "step-finish": "--color-step-finish",
    };
    for (const role of STEP_HUE_ROLES)
      expect(css).toContain(`--md-${role}: var(${token[role]});`);
  });

  it("never colours a lamp by step or workflow name", () => {
    const source = (label: string, names: string) => `
version: 1
parts:
  - { id: wf, kind: workflow, label: ${label}, scale: 1, props: { steps: [execute, route, execute] } }
cards:
  - { id: r, token: payload, label: ${names} }
story:
  - steps:
      - { verb: enter, part: wf, card: r }
`;
    const fills = (src: string) => {
      const d = compile(src);
      const { container, unmount } = render(
        <FlowDiagram diagram={d} t={0} reducedMotion />
      );
      const out = [...container.querySelectorAll(".md-step-core")].map((c) =>
        c.getAttribute("fill")
      );
      unmount();
      return out;
    };
    const plain = fills(source("deploy", "run"));
    expect(plain).toEqual([
      "var(--md-step-execute)",
      "var(--md-step-route)",
      "var(--md-step-execute)",
    ]);
    // Names that look like other step types change nothing.
    expect(fills(source("finish", "human_input"))).toEqual(plain);
    expect(fills(source("llm_inference", "wait_children"))).toEqual(plain);
  });

  it("pending lamps are full size at 40%, reached lamps pop to full opacity", () => {
    const steps = ["llm_inference", "execute"];
    const extra = extraFor(steps, [
      [
        [0, "off"],
        [1, "run"],
      ],
      [[0, "off"]],
    ]);
    const { container } = station(extra, 1.6);
    const [a, b] = [...container.querySelectorAll(".md-step-core")];
    expect(a.getAttribute("opacity")).toBe("1");
    expect(b.getAttribute("opacity")).toBe("0.4");
    expect(Number(b.getAttribute("r"))).toBeCloseTo(6.5, 6);
  });

  it("the rim follows step-execution state", () => {
    const steps = [
      "execute",
      "human_input",
      "wait_children",
      "llm_inference",
      "finish",
    ];
    const extra = extraFor(steps, [
      [
        [0, "off"],
        [1, "run"],
        [2, "ok"],
      ],
      [
        [0, "off"],
        [1, "park"],
      ],
      [
        [0, "off"],
        [1, "park"],
      ],
      [
        [0, "off"],
        [1, "run"],
        [2, "fail"],
      ],
      [[0, "off"]],
    ]);
    const rims = (t: number) => {
      const { container, unmount } = station(
        { ...extra, bursts: [[3, 2, "red"]] },
        t
      );
      const out = [...container.querySelectorAll(".md-step-lamp")].map((g) => ({
        rim: g.getAttribute("data-rim"),
        spinner: g.querySelector(".md-spinner") !== null,
        stroke: g.querySelector(".md-step-rim")?.getAttribute("stroke") ?? null,
        width:
          g.querySelector(".md-step-rim")?.getAttribute("stroke-width") ?? null,
      }));
      const burst = container
        .querySelector(".md-burst")
        ?.getAttribute("stroke");
      unmount();
      return { out, burst };
    };
    const executing = rims(1.5);
    expect(executing.out[0]).toEqual({
      rim: "run",
      spinner: true,
      stroke: null,
      width: null,
    });
    expect(executing.out[3].spinner).toBe(true);
    // Waiting: a still amber ring, no spinner (only human_input and wait_children park).
    expect(executing.out[1]).toEqual({
      rim: "park",
      spinner: false,
      stroke: "var(--md-amber)",
      width: "3",
    });
    expect(executing.out[2]).toEqual({
      rim: "park",
      spinner: false,
      stroke: "var(--md-amber)",
      width: "3",
    });
    // Pending: plain edge only.
    expect(executing.out[4]).toEqual({
      rim: "off",
      spinner: false,
      stroke: null,
      width: null,
    });
    const later = rims(2.4);
    expect(later.out[0]).toEqual({
      rim: "ok",
      spinner: false,
      stroke: "var(--md-green)",
      width: "2",
    });
    expect(later.out[3]).toEqual({
      rim: "fail",
      spinner: false,
      stroke: "var(--md-red)",
      width: "3",
    });
    expect(later.burst).toBe("var(--md-red)");
    expect(lampStateAt(extra.lamps[4], 9).state).toBe("off");
  });

  it("in a flow, wait parks only human_input / wait_children steps", () => {
    const rimAfterWait = (type: string) => {
      const d = compile(`
version: 1
parts:
  - { id: wf, kind: workflow, scale: 1, props: { steps: [${type}, finish] } }
cards:
  - { id: r, token: payload, label: run }
story:
  - steps:
      - { verb: enter, part: wf, card: r }
      - { verb: wait, part: wf }
`);
      const end = d.parts[0].steps.at(-1)!.end;
      const { container, unmount } = render(
        <FlowDiagram diagram={d} t={end - 0.05} reducedMotion={false} />
      );
      const rim = container
        .querySelector(".md-step-lamp")!
        .getAttribute("data-rim");
      const chip = container
        .querySelector(".md-chip")
        ?.getAttribute("data-role");
      unmount();
      return [rim, chip];
    };
    expect(rimAfterWait("human_input")).toEqual(["park", "amber"]);
    expect(rimAfterWait("wait_children")).toEqual(["park", "amber"]);
    expect(rimAfterWait("execute")).toEqual(["run", "ink"]);
    expect(rimAfterWait("route")).toEqual(["run", "ink"]);
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
  - { id: wf, kind: workflow, scale: 1, props: { steps: [llm_inference, execute, finish] } }
cards:
  - { id: r, token: payload, label: run }
story:
  - caption: the run enters and starts step 1
    steps:
      - { verb: enter, part: wf, card: r }
  - caption: step 1 completes and step 2 executes
    steps:
      - { verb: step, part: wf }
  - caption: step 2 completes and the finish step runs
    steps:
      - { verb: step, part: wf }
  - caption: the run finishes at the finish lamp
    steps:
      - { verb: finish, part: wf }
`;

/** The mechanism a picture shows: lamp rims, core opacity, chips, lit ports. */
function mechanism(root: Element) {
  return {
    lamps: [...root.querySelectorAll(".md-step-lamp")].map((g) => [
      g.getAttribute("data-step-type"),
      g.getAttribute("data-rim"),
      g.querySelector(".md-step-core")!.getAttribute("opacity"),
    ]),
    marks: [...root.querySelectorAll(".md-type-mark")].map((g) =>
      g.getAttribute("data-step-type")
    ),
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
    <MachineDiagram label="workflow">
      <CatalogPart
        def={workflowMachine as never}
        view={{ kind: "scenario", index, t }}
        reducedMotion={false}
      />
    </MachineDiagram>
  );
  const m = mechanism(container.querySelector("[data-part='workflow']")!);
  unmount();
  return m;
}

describe("the workflow flow kind", () => {
  it("is registered and a ```flow block using it renders its mechanism", () => {
    const d = compile(HAPPY);
    const p = d.parts[0];
    expect(p.kind).toBe("workflow");
    const { container } = render(
      <FlowDiagram diagram={d} t={beatOutcome(p.timeline, 1)} reducedMotion />
    );
    const part = container.querySelector("[data-part-id='wf']")!;
    expect(part).not.toBeNull();
    expect(part.querySelectorAll(".md-step-lamp")).toHaveLength(3);
    expect(part.querySelectorAll(".md-type-mark")).toHaveLength(3);
    expect(part.querySelector(".md-box")).not.toBeNull();
    // No standalone gallery rails inside flows.
    expect(part.querySelectorAll(".md-rail")).toHaveLength(0);
  });

  it("the happy path reproduces the gallery's completes scenario at the beat outcomes", () => {
    const d = compile(HAPPY);
    const tl = d.parts[0].timeline;
    const flowAt = (beat: number) => {
      const { container, unmount } = render(
        <FlowDiagram diagram={d} t={beatOutcome(tl, beat)} reducedMotion />
      );
      const m = mechanism(container.querySelector("[data-part-id='wf']")!);
      unmount();
      return m;
    };
    // The still (2.3 s): step 1 done, step 2 executing, finish pending, one active run.
    const still = galleryAt(0, workflowMachine.scenarios[0].still);
    expect(still).toEqual({
      lamps: [
        ["llm_inference", "ok", "1"],
        ["execute", "run", "1"],
        ["finish", "off", "0.4"],
      ],
      marks: ["llm_inference", "execute", "finish"],
      chips: ["ink"],
      lit: [],
    });
    expect(flowAt(1)).toEqual(still);
    // Step 1 executing (gallery 1.5 s) and finish done (gallery 3.3 s, after the burst).
    expect(flowAt(0).lamps).toEqual(galleryAt(0, 1.5).lamps);
    expect(flowAt(3).lamps).toEqual(galleryAt(0, 3.3).lamps);
    expect(flowAt(3).chips).toEqual([]);
    // Same status vocabulary as the gallery scenario.
    expect(tl.notes.map((n) => n[1])).toEqual(
      expect.arrayContaining([
        "run enters",
        "step 1/3 · llm_inference",
        "step 2/3 · execute",
        "finish · task done",
      ])
    );
  });

  it("a handoff leaves by its transition's port; a bundled one lights the bundle port with its target", () => {
    const d = compile(`
version: 1
parts:
  - { id: wf, kind: workflow, scale: 1, props: { steps: [llm_inference, route], transitions: [review, docs, release, rework, triage] } }
  - { id: next, kind: workflow, props: { steps: [execute] } }
rails:
  - { id: out, from: wf.out4, to: next.in }
cards:
  - { id: r, token: payload, label: run }
story:
  - caption: steps run
    steps:
      - { verb: enter, part: wf, card: r }
      - { verb: step, part: wf }
  - caption: handed off to triage by the bundle port
    steps:
      - { verb: hand off, part: wf, card: r, args: { to: triage } }
      - { verb: enter, part: next, card: r, via: out }
`);
    const wf = d.parts.find((p) => p.id === "wf")!;
    const at = wf.steps.find((s) => s.verb === "hand off")!;
    expect(at.outcome.exit).toBe("out4");
    const { container } = render(
      <FlowDiagram diagram={d} t={at.t + 0.4} reducedMotion={false} />
    );
    const part = container.querySelector("[data-part-id='wf']")!;
    const lit = part.querySelector("[data-lit]")!;
    expect(lit.getAttribute("data-port")).toBe("out4");
    expect(lit.textContent).toBe("→ triage");
    expect(wf.timeline.notes.map((n) => n[1])).toContain("handed off → triage");
  });

  it("a failure stops at its lamp: red rim, red card and chip, nothing leaves", () => {
    const d = compile(`
version: 1
parts:
  - { id: wf, kind: workflow, scale: 1, props: { steps: [structured_inference, execute, finish], transitions: [deploy] } }
cards:
  - { id: r, token: payload, label: run }
story:
  - steps:
      - { verb: enter, part: wf, card: r }
      - { verb: step, part: wf }
      - { verb: fail, part: wf, args: { reason: script error } }
`);
    const p = d.parts[0];
    const t = p.steps.at(-1)!.end - 0.05;
    const { container } = render(
      <FlowDiagram diagram={d} t={t} reducedMotion={false} />
    );
    const m = mechanism(container.querySelector("[data-part-id='wf']")!);
    expect(m.lamps.map((l) => l[1])).toEqual(["ok", "fail", "off"]);
    expect(m.chips).toEqual(["red"]);
    expect(m.lit).toEqual([]);
    expect(p.steps.every((s) => s.outcome.exit === undefined)).toBe(true);
    expect(p.timeline.notes.map((n) => n[1])).toContain(
      "failed at step 2 · execute · reason saved"
    );
  });
});

describe("performance at rest", () => {
  it("a flow of twelve workflow stations at rest schedules no animation frames", async () => {
    const raf = vi.spyOn(window, "requestAnimationFrame");
    const { MarkdownContent } = await import("../../shared/MarkdownContent");
    const parts = Array.from(
      { length: 12 },
      (_, i) =>
        `  - { id: w${i}, kind: workflow, props: { steps: [llm_inference, execute, ${i % 2 ? "human_input" : "route"}, finish], transitions: [next] } }`
    ).join("\n");
    const rails = Array.from(
      { length: 11 },
      (_, i) => `  - { id: r${i}, from: w${i}.out1, to: w${i + 1}.in }`
    ).join("\n");
    const spec = `version: 1\nparts:\n${parts}\nrails:\n${rails}\ncards:\n  - { id: c, token: payload, label: run }\nstory:\n  - steps:\n      - { verb: enter, part: w0, card: c }\n      - { verb: hand off, part: w0, card: c, args: { to: next } }\n      - { verb: enter, part: w1, card: c, via: r0 }\n`;
    raf.mockClear();
    const view = render(
      <MarkdownContent text={`\`\`\`flow\n${spec}\n\`\`\`\n`} />
    );
    await waitFor(
      () =>
        expect(
          view.container.querySelectorAll("[data-part='workflow']")
        ).toHaveLength(12),
      { timeout: 10000 }
    );
    expect(raf).not.toHaveBeenCalled();
    raf.mockRestore();
  });
});

it("outIndex and the gallery scenarios agree on the handoff ports", () => {
  const hands = workflowMachine.scenarios[3].extra;
  expect(outIndex(hands.layout, "docs")).toBe(1);
  const bundled = workflowMachine.scenarios[4].extra;
  expect(outIndex(bundled.layout, "triage")).toBe(3);
});
