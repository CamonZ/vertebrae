/**
 * The band (spec `band`): validation with paths and messages, the JSON
 * Schema, the reference example's rows and meter, its shared geometry, and
 * the rendered strip at two viewport widths.
 */
import { cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import inlineDiscussions from "./__fixtures__/inlineDiscussions.flow.yaml?raw";
import { FlowDiagram } from "./FlowDiagram";
import { ZOOM_GUTTER } from "../MachineDiagramViewport";
import {
  arrangement,
  bandLabels,
  bandRowLit,
  compileFlow,
  compileFlowLaidOut,
  compileFlowOrThrow,
  createFlowRegistry,
  flowSpecJsonSchema,
  formatFlowError,
  labelCollisions,
  meterCount,
  parseFlowSpec,
  partExtent,
  type DiagramTimeline,
  type FlowSpec,
} from "./index";

afterEach(cleanup);

const parsed = parseFlowSpec(inlineDiscussions);
if (!parsed.ok) throw new Error("fixture does not parse");
const reference = parsed.value as FlowSpec;
const flow = compileFlowOrThrow(reference);
const before = arrangement(flow, "before")!;
const after = arrangement(flow, "after")!;

function errorsOf(input: unknown) {
  const r = compileFlow(input, { registry: createFlowRegistry() });
  expect(r.ok).toBe(false);
  return r.ok ? [] : r.errors.map(formatFlowError);
}

/* eslint-disable @typescript-eslint/no-explicit-any -- the error tests break specs field by field */
const base = (): any => ({
  version: 1,
  parts: [
    { id: "src", kind: "source", position: { x: 0, y: 0 } },
    { id: "w", kind: "worker", position: { x: 400, y: 0 } },
  ],
  rails: [{ id: "jobs", from: "src.out", to: "w.in" }],
  story: [
    { id: "ask", caption: "a job is asked for" },
    { id: "wait", caption: "nothing happens" },
  ],
  band: {
    heading: "BETWEEN JOBS",
    rows: [{ name: "idle", note: "no job", chips: ["waits"], beats: ["wait"] }],
  },
});

describe("band validation names the spec path", () => {
  it("accepts a minimal band", () => {
    expect(compileFlow(base()).ok).toBe(true);
  });

  it("unknown fields on the band, a row and the meter", () => {
    const s = base();
    s.band.colour = "red";
    s.band.rows[0].lit = true;
    s.band.meter = { label: "jobs", marker: "arrival", ring: 3 };
    expect(errorsOf(s)).toEqual([
      'band.colour: unknown field "colour"; allowed: heading, meter, rows',
      'band.rows[0].lit: unknown field "lit"; allowed: beats, chips, name, note',
      'band.meter.ring: unknown field "ring"; allowed: footnote, label, marker',
    ]);
  });

  it("rows naming missing beats suggest the beat ids", () => {
    const s = base();
    s.band.rows[0].beats = ["wiat", "gone"];
    const errs = errorsOf(s);
    expect(errs).toContain(
      'band.rows[0].beats[0]: band row names missing beat "wiat" (did you mean "wait"?); beat ids: ask, wait'
    );
    expect(errs).toContain(
      'band.rows[0].beats[1]: band row names missing beat "gone"; beat ids: ask, wait'
    );
  });

  it("empty and malformed chip lists, shared or per arrangement", () => {
    const s = base();
    s.band.rows = [
      { name: "a", chips: [], beats: ["ask"] },
      { name: "b", chips: { before: ["x"], after: [] }, beats: ["ask"] },
      { name: "c", chips: { before: ["x"] }, beats: ["ask"] },
      { name: "d", chips: ["ok", ""], beats: ["ask"] },
      { name: "e", beats: ["ask"] },
      { name: "f", chips: "one", beats: ["ask"] },
    ];
    const errs = errorsOf(s);
    expect(errs).toEqual([
      "band.rows[0].chips: needs at least one chip",
      "band.rows[1].chips.after: needs at least one chip",
      "band.rows[2].chips.after: is required (give both before and after)",
      "band.rows[3].chips[1]: expected a non-empty string",
      "band.rows[4].chips: is required",
      "band.rows[5].chips: expected a list of chip texts",
    ]);
  });

  it("rows, beats, names and the meter are required where they matter", () => {
    const empty = base();
    empty.band.rows = [];
    expect(errorsOf(empty)).toEqual(["band.rows: needs at least one row"]);
    const s = base();
    s.band.rows = [
      { chips: ["x"], beats: [] },
      { name: "twice", chips: ["x"], beats: ["ask", "ask"] },
      { name: "n", note: { before: "", after: "y" }, chips: ["x"] },
    ];
    s.band.meter = { label: "jobs", marker: [] };
    expect(errorsOf(s)).toEqual([
      "band.rows[0].name: is required",
      "band.rows[0].beats: needs at least one beat id",
      'band.rows[1].beats[1]: beat "ask" is listed twice',
      "band.rows[2].note.before: expected a non-empty string",
      "band.rows[2].beats: is required",
      "band.meter.marker: needs at least one marker kind",
    ]);
    expect(errorsOf({ ...base(), band: [] })).toEqual([
      "band: expected a band object with rows",
    ]);
  });

  it("a drill-down's band is checked at its own path", () => {
    const s = base();
    const inner = base();
    inner.band.rows[0].beats = ["nope"];
    s.parts[0].drill = { spec: inner };
    expect(errorsOf(s)).toEqual([
      'parts[0].drill.spec.band.rows[0].beats[0]: band row names missing beat "nope"; beat ids: ask, wait',
    ]);
  });

  it("the JSON Schema describes the band", () => {
    const schema = flowSpecJsonSchema(createFlowRegistry()) as {
      properties: Record<string, unknown>;
      $defs: Record<string, { required?: string[]; properties: object }>;
    };
    expect(schema.properties.band).toEqual({ $ref: "#/$defs/band" });
    expect(schema.$defs.band.required).toEqual(["rows"]);
    expect(Object.keys(schema.$defs.band.properties)).toEqual([
      "heading",
      "rows",
      "meter",
    ]);
    expect(schema.$defs.bandRow.required).toEqual(["name", "chips", "beats"]);
  });
});

describe("the reference example's band", () => {
  const rowsOf = (d: DiagramTimeline) =>
    d.band!.rows.map((r) => [r.name, r.note, r.chips.map((c) => c.text)]);

  it("shows different rows Before and After", () => {
    expect(rowsOf(before)).toEqual([
      [
        "cancel",
        "mid-reply",
        ["stop the turn", "process closed", "next ask spawns"],
      ],
      [
        "collapse",
        "thread hidden",
        ["no process between asks", "nothing to keep"],
      ],
      ["tool call", "none", ['--tools ""', "answers from pasted context"]],
    ]);
    expect(rowsOf(after)).toEqual([
      [
        "cancel",
        "mid-reply",
        ["interrupt_local_chat_turn", "turn ends", "process kept"],
      ],
      [
        "collapse",
        "thread hidden",
        ["idle process closed", "providerResumeId kept", "next ask resumes"],
      ],
      [
        "tool call",
        "read-only",
        ["read_only_decision", "Read · Grep · Glob", "anything else: deny"],
      ],
    ]);
  });

  it("counts process starts from the compile: 4 before, 2 after", () => {
    expect(before.band!.meter!.times).toHaveLength(4);
    expect(after.band!.meter!.times).toHaveLength(2);
    expect(after.band!.meter!.footnote).toBe("before: 4  ·  after: 2");
    expect(meterCount(after.band!.meter!, after.period)).toBe(2);
    expect(meterCount(after.band!.meter!, 0)).toBe(0);
  });

  it("lights a row only in its beats; a beat missing from an arrangement lights nothing", () => {
    const lit = (d: DiagramTimeline, beat: string) => {
      const b = d.beats.find((x) => x.id === beat)!;
      return d.band!.rows.filter((r) => bandRowLit(r, b.t)).map((r) => r.name);
    };
    expect(lit(after, "cancel")).toEqual(["cancel"]);
    expect(lit(after, "collapse")).toEqual(["collapse"]);
    expect(lit(after, "tools")).toEqual(["tool call"]);
    expect(lit(after, "edit")).toEqual(["tool call"]);
    expect(lit(after, "q2")).toEqual([]);
    expect(before.beatWindows.edit).toBeUndefined();
    expect(before.band!.rows[2].windows).toEqual([before.beatWindows.tools]);
  });

  it("sits below the diagram in one geometry for both arrangements", async () => {
    const laid = await compileFlowLaidOut(reference);
    if (!laid.ok) throw new Error("layout failed");
    for (const f of [flow, laid.flow]) {
      const [b, a] = f.arrangements;
      expect([a.width, a.height]).toEqual([b.width, b.height]);
      expect([a.band!.y, a.band!.x0, a.band!.x1, a.band!.chipX]).toEqual([
        b.band!.y,
        b.band!.x0,
        b.band!.x1,
        b.band!.chipX,
      ]);
      expect(a.band!.rows.map((r) => r.y)).toEqual(
        b.band!.rows.map((r) => r.y)
      );
      expect(a.band!.meter!.x).toBe(b.band!.meter!.x);
      for (const d of f.arrangements) {
        for (const p of d.parts)
          expect(partExtent(p).y1).toBeLessThan(d.band!.y);
        for (const r of d.rails)
          for (const [, y] of r.points) expect(y).toBeLessThan(d.band!.y);
        expect(labelCollisions(d).filter((h) => h.includes("band:"))).toEqual(
          []
        );
      }
    }
  });

  it("a spec without a band compiles as it did, with no band", () => {
    const bare = { ...reference } as FlowSpec & { band?: unknown };
    delete bare.band;
    const plain = compileFlowOrThrow(bare);
    for (const d of plain.arrangements) {
      expect(d.band).toBeUndefined();
      expect(d.height).toBeLessThan(before.band!.y);
    }
  });
});

describe("band rows light inside their windows", () => {
  it("a row is lit exactly on [start, end) of one of its windows", () =>
    hegel.test((tc) => {
      const cuts = tc
        .draw(
          gs.arrays(gs.floats({ minValue: 0, maxValue: 60 }), {
            minSize: 0,
            maxSize: 6,
          })
        )
        .sort((a, b) => a - b);
      const windows: [number, number][] = [];
      for (let i = 0; i + 1 < cuts.length; i += 2)
        windows.push([cuts[i], cuts[i + 1]]);
      const t = tc.draw(
        gs.oneOf(
          gs.floats({ minValue: -1, maxValue: 61 }),
          gs.sampledFrom(cuts.length ? cuts : [0])
        )
      );
      const inside = windows.some(([a, b]) => t >= a && t < b);
      if (bandRowLit({ windows }, t) !== inside)
        throw new Error(`t ${t} windows ${JSON.stringify(windows)}`);
    }));
});

describe("the rendered band", () => {
  /** Diagram-space geometry of every band element, as rendered. */
  function drawn(container: HTMLElement) {
    const band = container.querySelector("[data-testid='flow-band']")!;
    return [...band.querySelectorAll("rect, text, circle, line")].map((e) =>
      ["x", "y", "width", "height", "cx", "cy", "x1", "x2"].map((k) =>
        e.getAttribute(k)
      )
    );
  }

  function renderAt(width: number, d: DiagramTimeline, t: number) {
    const desc = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "clientWidth"
    );
    Object.defineProperty(HTMLElement.prototype, "clientWidth", {
      configurable: true,
      get: () => width,
    });
    try {
      return render(<FlowDiagram diagram={d} t={t} reducedMotion={false} />);
    } finally {
      if (desc)
        Object.defineProperty(HTMLElement.prototype, "clientWidth", desc);
    }
  }

  it("draws the divider, heading, rows, chips and meter where the extents say, at any viewport width", () => {
    const t = after.beats.find((b) => b.id === "cancel")!.t + 0.1;
    const narrow = renderAt(480, after, t);
    const a = drawn(narrow.container);
    const text = narrow.container.querySelector(
      "[data-testid='flow-band']"
    )!.textContent;
    expect(text).toContain("BETWEEN QUESTIONS");
    expect(text).toContain("processes started");
    const rows = [...narrow.container.querySelectorAll("[data-band-row]")];
    expect(rows.map((r) => r.getAttribute("data-lit"))).toEqual([
      "true",
      "false",
      "false",
    ]);
    // Every chip pill is drawn where its label box is.
    const pills = [
      ...narrow.container.querySelectorAll(".md-band-chip rect"),
    ].map((r) => Number(r.getAttribute("x")));
    expect(pills).toEqual(
      bandLabels(after.band!)
        .filter((l) => l.kind === "chip")
        .map((l) => l.x0)
    );
    // The zoom control keeps its own column, so it never covers the band's
    // left edge.
    const stage = narrow.container.querySelector<HTMLElement>(".md-stage")!;
    expect(stage.style.left).toBe(`${ZOOM_GUTTER}px`);
    expect(Number(stage.dataset.zoom)).toBeCloseTo(
      (480 - ZOOM_GUTTER) / after.width
    );
    cleanup();
    const wide = renderAt(1920, after, t);
    expect(drawn(wide.container)).toEqual(a);
  });

  it("fills one ring per counted marker as the story passes it", () => {
    const m = before.band!.meter!;
    const { container, rerender } = render(
      <FlowDiagram diagram={before} t={0} reducedMotion />
    );
    const meter = () =>
      container.querySelector("[data-testid='flow-band-meter']")!;
    expect(meter().getAttribute("data-total")).toBe("4");
    expect(meter().getAttribute("data-count")).toBe("0");
    rerender(<FlowDiagram diagram={before} t={m.times[1]} reducedMotion />);
    expect(meter().getAttribute("data-count")).toBe("2");
    expect(
      [...meter().querySelectorAll("[data-filled]")].map((e) =>
        e.getAttribute("data-filled")
      )
    ).toEqual(["true", "true", "false", "false"]);
  });

  it("a diagram without a band draws none", () => {
    const bare = { ...reference } as FlowSpec & { band?: unknown };
    delete bare.band;
    const d = compileFlowOrThrow(bare).arrangements[1];
    const { container } = render(<FlowDiagram diagram={d} t={1} />);
    expect(container.querySelector("[data-testid='flow-band']")).toBeNull();
  });
});
