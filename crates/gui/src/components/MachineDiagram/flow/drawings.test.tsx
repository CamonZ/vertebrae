import { render, cleanup } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it } from "vitest";
import { MACHINE_PARTS } from "../parts";
import { compileFlow, compileFlowOrThrow } from "./compile";
import { FlowDiagram } from "./FlowDiagram";
import { createFlowRegistry } from "./defaults";
import { FlowRegistryContext } from "./registryContext";
import { FLOW_DRAWINGS } from "./drawings";
import mechanismSpec from "./__fixtures__/mechanisms.flow.yaml?raw";
import { parseFlowSpec } from "./parse";
import { beatOutcome } from "./useFlowClock";
import type { StepSpec } from "./spec";

afterEach(cleanup);
const svg = (node: React.ReactNode) => renderToStaticMarkup(<svg>{node}</svg>);
function compile(
  kind: string,
  steps: readonly Omit<StepSpec, "part">[] = [],
  props = {}
) {
  return compileFlowOrThrow({
    version: 1,
    parts: [{ id: "unit", kind, props, scale: 1 }],
    cards: ["a", "b", "c", "d"].map((id) => ({
      id,
      token: kind === "aggregator" || kind === "joiner" ? "data" : "request",
    })),
    story: [
      { caption: "Outcome", steps: steps.map((s) => ({ ...s, part: "unit" })) },
    ],
  }).arrangements[0];
}

describe("registered flow mechanisms", () => {
  it.each(Object.keys(MACHINE_PARTS) as (keyof typeof MACHINE_PARTS)[])(
    "renders %s's catalogue geometry beneath its part id",
    (kind) => {
      const d = compile(kind);
      const { container } = render(
        <FlowDiagram diagram={d} t={0} reducedMotion={false} />
      );
      const part = container.querySelector('[data-part-id="unit"]')!;
      const mechanism = svg(FLOW_DRAWINGS[kind](0, d.parts[0]));
      const host = document.createElement("div");
      host.innerHTML = mechanism;
      const elements = [...host.querySelector("svg")!.children];
      for (const e of [
        ...host.querySelectorAll<SVGElement>("[style]"),
        ...part.querySelectorAll<SVGElement>("[style]"),
      ])
        e.setAttribute("style", e.style.cssText);
      // A trace at rest is only its frame; its spans appear as steps record them.
      expect(elements.length).toBeGreaterThan(kind === "trace" ? 0 : 1);
      expect(
        part.innerHTML.startsWith(elements.map((e) => e.outerHTML).join(""))
      ).toBe(true);
      expect(part.innerHTML).not.toContain("NaN");
    }
  );

  it("honors a context extension and uses the fallback only when no drawing is registered", () => {
    const registry = createFlowRegistry();
    const base = {
      job: "custom",
      footprint: "S" as const,
      bb: [10, 20, 30, 40] as const,
      status: { x: 20, y: 70 },
      ports: {},
      init: () => ({ value: 0 }),
      verbs: {
        tick: {
          duration: 1,
          compile: ({ state }: { state: { value: number } }) => {
            state.value++;
          },
        },
      },
    };
    registry.parts.register({
      ...base,
      kind: "custom",
      draw: (t, p) => (
        <circle data-custom={p.state.value} cx={t} cy={20} r={5} />
      ),
    });
    registry.parts.register({ ...base, kind: "placeholder" });
    const d = compileFlowOrThrow(
      {
        version: 1,
        parts: [
          { id: "a", kind: "custom" },
          { id: "b", kind: "placeholder" },
        ],
        story: [{ steps: [{ part: "a", verb: "tick" }] }],
      },
      { registry }
    ).arrangements[0];
    const { container } = render(
      <FlowRegistryContext.Provider value={registry}>
        <FlowDiagram diagram={d} t={0.9} reducedMotion={false} />
      </FlowRegistryContext.Provider>
    );
    expect(container.querySelector('[data-custom="1"]')).toHaveAttribute(
      "cx",
      "0.9"
    );
    expect(
      container.querySelector(
        '[data-part-id="b"] rect[width="30"][height="40"]'
      )
    ).not.toBeNull();
  });

  it("a drawing returning null does not request a fallback", () => {
    const registry = createFlowRegistry();
    registry.parts.register({
      ...registry.parts.get("source")!,
      kind: "invisible",
      draw: () => null,
    });
    const d = compileFlowOrThrow(
      { version: 1, parts: [{ id: "empty", kind: "invisible" }] },
      { registry }
    ).arrangements[0];
    const { container } = render(
      <FlowRegistryContext.Provider value={registry}>
        <FlowDiagram diagram={d} t={0} />
      </FlowRegistryContext.Provider>
    );
    expect(
      container.querySelector(
        '[data-part-id="empty"] rect[width="80"][height="64"]'
      )
    ).toBeNull();
  });
});

// Align flow verbs with the gallery's mechanism clock. Compare the actual SVG,
// not snapshots regenerated from the adapter under test.
describe("happy-path gallery still parity", () => {
  it.each(["source", "transform", "splitter", "boundary"] as const)(
    "%s",
    (kind) => {
      const machine = MACHINE_PARTS[kind];
      const sc = machine.scenarios[0];
      const d = compile(
        kind,
        kind === "transform"
          ? [{ verb: "transform", card: "a" }]
          : kind === "splitter"
            ? [{ verb: "split", card: "a" }]
            : []
      );
      // Gallery defaults retain the same geometry and happy-path timing.
      const expected =
        kind === "boundary"
          ? MACHINE_PARTS.boundary.draw(sc.still, { cut: null })
          : kind === "source"
            ? MACHINE_PARTS.source.draw(sc.still, null)
            : kind === "transform"
              ? MACHINE_PARTS.transform.draw(sc.still, null)
              : MACHINE_PARTS.splitter.draw(sc.still, null);
      expect(svg(FLOW_DRAWINGS[kind](sc.still, d.parts[0]))).toBe(
        svg(expected)
      );
    }
  );
  it("client screen after response", () => {
    const d = compile("client", [
      { verb: "send", card: "a" },
      { verb: "render", card: "b", delay: 1.2 },
    ]);
    const sc = MACHINE_PARTS.client.scenarios[0];
    expect(svg(FLOW_DRAWINGS.client(3, d.parts[0]))).toBe(
      svg(MACHINE_PARTS.client.draw(3, sc.extra))
    );
  });
  it("worker clamping and lights while working", () => {
    const d = compile("worker", [
      { verb: "stage", card: "a" },
      { verb: "finish", card: "a", delay: 1.25 },
    ]);
    const sc = MACHINE_PARTS.worker.scenarios[0];
    expect(svg(FLOW_DRAWINGS.worker(sc.still, d.parts[0]))).toBe(
      svg(MACHINE_PARTS.worker.draw(sc.still, sc.extra))
    );
  });
});

describe("remaining happy-path gallery stills", () => {
  it("router arm", () => {
    const d = compile("router", [
      { verb: "decide", card: "a", args: { to: "r1" } },
    ]);
    const machine = MACHINE_PARTS.router;
    // Shift the gallery's arm onset by 0.1 s to match this verb's travel time.
    const extra = {
      ...machine.scenarios[0].extra,
      arm: [
        [0, 0],
        [1.15, -1],
      ] as const,
    };
    expect(svg(FLOW_DRAWINGS.router(1.7, d.parts[0]))).toBe(
      svg(machine.draw(1.7, extra))
    );
  });
  it("joiner branch rings", () => {
    const d = compile("joiner", [
      { verb: "wait", card: "a", delay: 0.2 },
      { verb: "join", card: "b", delay: 0.4, args: { branch: "b" } },
      { verb: "release", with: true, delay: 0.3 },
    ]);
    const machine = MACHINE_PARTS.joiner;
    expect(svg(FLOW_DRAWINGS.joiner(1.9, d.parts[0]))).toBe(
      svg(machine.draw(1.9, machine.scenarios[0].extra))
    );
  });
  it("aggregator collection bars and piston", () => {
    const d = compile(
      "aggregator",
      ["a", "b", "c", "d"].map((card, i) => ({
        verb: "record",
        card,
        ...(i ? { with: true, delay: 0.25 } : { delay: 0.1 }),
      }))
    );
    const machine = MACHINE_PARTS.aggregator;
    // Compare the first four arrivals before the fifth gallery bar appears.
    expect(svg(FLOW_DRAWINGS.aggregator(2, d.parts[0]))).toBe(
      svg(machine.draw(2, machine.scenarios[0].extra))
    );
  });
  it("pipeline lamps and stage ring", () => {
    const d = compile("pipeline", [
      { verb: "stage", card: "a", delay: 0.05 },
      { verb: "stage", card: "a", with: true, delay: 0.95 },
      { verb: "stage", card: "a", with: true, delay: 0.95 },
      { verb: "finish", card: "a", with: true, delay: 0.95 },
    ]);
    const machine = MACHINE_PARTS.pipeline;
    expect(svg(FLOW_DRAWINGS.pipeline(2.2, d.parts[0]))).toBe(
      svg(machine.draw(2.2, machine.scenarios[0].extra))
    );
  });
  it("pool occupancy and released seat", () => {
    const d = compile("pool", [
      { verb: "spawn", card: "a" },
      { verb: "spawn", card: "b", with: true, delay: 0.3 },
      { verb: "spawn", card: "c", with: true, delay: 0.3 },
      { verb: "release", card: "a", with: true, delay: 1 },
      { verb: "release", card: "b", with: true, delay: 0.6 },
      { verb: "release", card: "c", with: true, delay: 0.5 },
    ]);
    const machine = MACHINE_PARTS.pool;
    expect(svg(FLOW_DRAWINGS.pool(2.25, d.parts[0]))).toBe(
      svg(machine.draw(2.25, machine.scenarios[0].extra))
    );
  });
});

describe("compiled timing and outcomes", () => {
  it("the four-kind chat fixture compiles and retains its mechanisms at every beat", () => {
    const parsed = parseFlowSpec(mechanismSpec);
    if (!parsed.ok) throw new Error("mechanism fixture does not parse");
    const d = compileFlowOrThrow(parsed.value).arrangements[0];
    for (let i = 0; i < d.beats.length; i++) {
      const { container, unmount } = render(
        <FlowDiagram diagram={d} t={beatOutcome(d.travel, i)} reducedMotion />
      );
      expect(container.querySelectorAll("[data-part-id]")).toHaveLength(4);
      expect(container.querySelector(".md-press")).not.toBeNull();
      expect(container.innerHTML).not.toContain("NaN");
      unmount();
    }
  });
  it("delayed and repeated stamps follow the compiled clock", () => {
    const d = compile("transform", [
      { verb: "transform", card: "a", delay: 3 },
      { verb: "transform", card: "b", delay: 2 },
    ]);
    const at = d.parts[0].steps[1].t + 0.75;
    expect(svg(FLOW_DRAWINGS.transform(at, d.parts[0]))).toBe(
      svg(
        MACHINE_PARTS.transform.draw(at, {
          stampAt: d.parts[0].steps[1].t + 0.65,
        })
      )
    );
    expect(svg(FLOW_DRAWINGS.transform(1.35, d.parts[0]))).toBe(
      svg(MACHINE_PARTS.transform.draw(0, null))
    );
  });
  it("client error and boundary partition use their compiled outcomes", () => {
    const client = compile("client", [
      { verb: "render", card: "a", delay: 2, args: { outcome: "error" } },
    ]).parts[0];
    expect(svg(FLOW_DRAWINGS.client(3.4, client))).toBe(
      svg(
        MACHINE_PARTS.client.draw(3.4, { done: 2.95, hang: null, error: true })
      )
    );
    const boundary = compile("boundary", [
      { verb: "cross", card: "a", delay: 2, args: { outcome: "partition" } },
    ]).parts[0];
    expect(svg(FLOW_DRAWINGS.boundary(3.1, boundary))).toBe(
      svg(MACHINE_PARTS.boundary.draw(3.1, { cut: 2.9 }))
    );
  });
});

describe("data, state, lifecycle and event-sourcing mechanisms", () => {
  const kinds = [
    "store",
    "cache",
    "document",
    "state machine",
    "reactive cell",
    "schema",
    "transaction",
    "lock",
    "session",
    "event store",
    "decider",
    "projection",
    "snapshot",
    "replay",
    "upcaster",
    "saga",
    "outbox",
    "consumer offset",
    "idempotency guard",
  ] as const;
  const registry = createFlowRegistry();

  it.each(kinds)("%s draws every verb across its story without NaN", (kind) => {
    for (const [verb, def] of Object.entries(registry.parts.get(kind)!.verbs)) {
      // A verb takes particular tokens (control, signal, data…): try each card.
      const tokens = [
        "request",
        "data",
        "result",
        "control",
        "signal",
        "event",
      ];
      const part = tokens
        .map((token) =>
          compileFlow({
            version: 1,
            parts: [{ id: "unit", kind, props: {}, scale: 1 }],
            cards: [{ id: "a", token }],
            story: [
              {
                caption: "Outcome",
                steps: [
                  def.card === "none"
                    ? { part: "unit", verb }
                    : { part: "unit", verb, card: "a" },
                ],
              },
            ],
          } as never)
        )
        .find((r) => r.ok)?.flow.arrangements[0].parts[0];
      expect(part, `${kind}.${verb} compiles with some token`).toBeDefined();
      if (!part) continue;
      for (let t = 0; t <= part.timeline.period; t += 0.25) {
        const html = svg(FLOW_DRAWINGS[kind](t, part));
        expect(html, `${kind}.${verb} @ ${t}`).not.toContain("NaN");
        expect(html).not.toContain("undefined");
      }
    }
  });
});

describe("vertebrae workflow mechanisms", () => {
  const kinds = [
    "inference step",
    "structured step",
    "execute step",
    "route step",
    "wait children",
    "human gate",
    "run end",
    "task run",
  ] as const;
  const registry = createFlowRegistry();

  it.each(kinds)("%s draws every verb across its story without NaN", (kind) => {
    for (const [verb, def] of Object.entries(registry.parts.get(kind)!.verbs)) {
      const tokens = ["request", "data", "payload", "result", "control"];
      const part = tokens
        .map((token) =>
          compileFlow({
            version: 1,
            parts: [{ id: "unit", kind, props: {}, scale: 1 }],
            cards: [{ id: "a", token }],
            story: [
              {
                caption: "Outcome",
                steps: [
                  def.card === "none"
                    ? { part: "unit", verb }
                    : { part: "unit", verb, card: "a" },
                ],
              },
            ],
          } as never)
        )
        .find((r) => r.ok)?.flow.arrangements[0].parts[0];
      expect(part, `${kind}.${verb} compiles with some token`).toBeDefined();
      if (!part) continue;
      for (let t = 0; t <= part.timeline.period; t += 0.25) {
        const html = svg(FLOW_DRAWINGS[kind](t, part));
        expect(html, `${kind}.${verb} @ ${t}`).not.toContain("NaN");
        expect(html).not.toContain("undefined");
      }
    }
  });
});
