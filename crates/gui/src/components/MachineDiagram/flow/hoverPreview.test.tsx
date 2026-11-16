import { act, render, renderHook } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PartContext } from "../partContext";
import { compileFlowOrThrow } from "./compile";
import { FlowDiagram } from "./FlowDiagram";
import {
  PREVIEW_BEAT,
  PREVIEW_LEAD,
  hoverPreview,
  sequenceLamps,
  usePreviewClock,
} from "./hoverPreview";
import { decisionPort } from "./parts/topology";
import type { FlowSpec } from "./spec";

const SPEC: FlowSpec = {
  version: 1,
  parts: [
    {
      id: "wf",
      kind: "workflow",
      props: {
        steps: ["llm_inference", "execute", "finish"],
        transitions: [],
        topology: true,
      },
    },
    { id: "step", kind: "execute step", props: { topology: true } },
    {
      id: "route",
      kind: "route step",
      props: {
        topology: true,
        decisions: ["ok", "retry"],
        defaultDecision: true,
      },
    },
    { id: "end", kind: "topology endpoint" },
  ],
};
const parts = () => compileFlowOrThrow(SPEC).arrangements[0].parts;
const part = (id: string) => parts().find((p) => p.id === id)!;

const markup = (node: React.ReactNode) =>
  renderToStaticMarkup(
    <svg>
      <PartContext.Provider
        value={{
          fade: 1,
          removed: false,
          labels: true,
          hatchId: "h",
          inFlow: true,
        }}
      >
        {node}
      </PartContext.Provider>
    </svg>
  );
const rims = (html: string) =>
  [...html.matchAll(/data-rim="(\w+)"/g)].map((m) => m[1]);

const MID = PREVIEW_LEAD + PREVIEW_BEAT * 1.5;
const cardCount = (html: string) => html.match(/class="md-card"/g)?.length ?? 0;
const draw = (id: string, t: number) =>
  markup(hoverPreview(part(id))!.draw(t, false));

describe("hoverPreview", () => {
  it("lights a workflow's lamps one after another, never by step name", () => {
    const preview = hoverPreview(part("wf"))!;
    expect(rims(draw("wf", 0))).toEqual(["off", "off", "off"]);
    expect(rims(draw("wf", MID))).toEqual(["ok", "run", "off"]);
    expect(rims(draw("wf", preview.period - 0.01))).toEqual(["ok", "ok", "ok"]);
  });

  it("carries a payload card through a station while its lamps run", () => {
    expect(cardCount(draw("wf", MID))).toBe(1);
    // Gone before the loop restarts.
    expect(cardCount(draw("wf", hoverPreview(part("wf"))!.period - 0.01))).toBe(
      0
    );
  });

  it("tries a route's decisions in order and leaves by the last", () => {
    const preview = hoverPreview(part("route"))!;
    const lit = (t: number) =>
      [
        ...draw("route", t).matchAll(
          /data-preview-row="([^"]+)" data-role="(\w+)"/g
        ),
      ].map((m) => `${m[1]}:${m[2]}`);
    expect(lit(0)).toEqual([]);
    expect(lit(PREVIEW_LEAD + 0.01)).toEqual([`${decisionPort("ok")}:amber`]);
    expect(lit(MID)).toEqual([`${decisionPort("retry")}:amber`]);
    expect(lit(PREVIEW_LEAD + PREVIEW_BEAT * 3 + 0.01)).toEqual([
      "default:green",
    ]);
    expect(cardCount(draw("route", MID))).toBe(1);
    expect(cardCount(draw("route", preview.period - 0.01))).toBe(0);
  });

  it("plays a step's catalogue scenario with an untagged payload", () => {
    const preview = hoverPreview(part("step"))!;
    const frames = Array.from({ length: 20 }, (_, i) =>
      draw("step", (preview.period * i) / 20)
    );
    expect(new Set(frames).size).toBeGreaterThan(2);
    expect(frames.some((f) => cardCount(f) > 0)).toBe(true);
    // Nothing from the scenario's words or a real run.
    for (const f of frames)
      expect(f).not.toMatch(/data-card-id|claude|typesafe/);
  });

  it("has no preview for parts without a mechanism", () => {
    expect(hoverPreview(part("end"))).toBeNull();
  });

  it("sequences one lamp per beat", () => {
    expect(sequenceLamps(2)[1]).toEqual([
      [0, "off"],
      [PREVIEW_LEAD + PREVIEW_BEAT, "run"],
      [PREVIEW_LEAD + 2 * PREVIEW_BEAT, "ok"],
    ]);
  });
});

describe("usePreviewClock", () => {
  let frames = new Map<number, FrameRequestCallback>();
  let next = 0;
  beforeEach(() => {
    frames = new Map();
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.set(++next, cb);
      return next;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation((id) => {
      frames.delete(id);
    });
  });
  afterEach(() => vi.restoreAllMocks());
  const run = (ms: number) => {
    const pending = [...frames.values()];
    frames = new Map();
    act(() => pending.forEach((cb) => cb(ms)));
  };

  it("runs frames only while a preview plays, looping over its period", () => {
    const { result, rerender } = renderHook(
      ({ period }) => usePreviewClock(period, false),
      { initialProps: { period: null as number | null } }
    );
    expect(window.requestAnimationFrame).not.toHaveBeenCalled();
    rerender({ period: 2 });
    run(1000);
    run(1500);
    expect(result.current).toBeCloseTo(0.5);
    run(3200);
    expect(result.current).toBeCloseTo(0.2);
    rerender({ period: null });
    expect(frames.size).toBe(0);
    expect(result.current).toBe(0);
  });

  it("advances in whole beats under reduced motion", () => {
    const { result } = renderHook(() => usePreviewClock(5, true));
    run(1000);
    run(1000 + PREVIEW_BEAT * 2.6 * 1000);
    expect(result.current).toBeCloseTo(PREVIEW_BEAT * 2);
  });
});

describe("FlowDiagram preview", () => {
  afterEach(() => vi.restoreAllMocks());
  it("plays the preview only on the part the host names", () => {
    const diagram = compileFlowOrThrow(SPEC).arrangements[0];
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, "cancelAnimationFrame").mockImplementation(() => {});
    const v = render(
      <FlowDiagram diagram={diagram} t={0} reducedMotion={false} />
    );
    expect(frames).toHaveLength(0);
    v.rerender(
      <FlowDiagram
        diagram={diagram}
        t={0}
        reducedMotion={false}
        presentation={{ preview: "wf" }}
      />
    );
    expect(frames).toHaveLength(1);
    act(() => frames.shift()!(1000));
    act(() => frames.shift()!(1000 + MID * 1000));
    expect(rims(v.container.innerHTML)).toEqual(["ok", "run", "off"]);
  });
});
