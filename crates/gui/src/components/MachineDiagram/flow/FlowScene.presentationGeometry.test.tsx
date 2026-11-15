import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import * as hegel from "@hegeldev/hegel";
import * as gs from "@hegeldev/hegel/generators";
import { buildMachineFlow } from "../../WorkflowAtlas/adapter/buildMachineFlow";
import { fixture } from "../../WorkflowAtlas/adapter/machineFlow.fixture";
import { compileFlow, compileFlowOrThrow } from "./compile";
import {
  regionLabels,
  regionLabelAt,
  regionCountAt,
  overlaps,
  textBox,
  partLabelsLocal,
} from "./extent";
import { FlowScene } from "./FlowDiagram";
import { RegionHeader } from "./RegionHeader";
import css from "../MachineDiagram.css?raw";

afterEach(cleanup);

it("header render anchors and reserved label/count boxes agree across names and live counts", () =>
  hegel.test(
    (tc) => {
      const name = "Workflow ".repeat(
        tc.draw(gs.integers({ minValue: 1, maxValue: 30 }))
      );
      const total = tc.draw(gs.integers({ minValue: 1, maxValue: 99999 }));
      const running = tc.draw(gs.integers({ minValue: 0, maxValue: total }));
      const region = {
        id: "region",
        label: name,
        liveHeader: true,
        parts: ["part"],
        x: 17,
        y: 23,
        width: Math.max(600, name.length * 10.8 + 40),
        height: 400,
      };
      const view = render(
        <svg>
          <RegionHeader
            region={region}
            presentation={{
              counts: new Map([[region.id, { total, running }]]),
              onActivateRegion: () => {},
            }}
          />
        </svg>
      );
      try {
        expect(view.getByRole("button")).toHaveAccessibleName(
          `${name}. ${total} parked, ${running} active`
        );
        const labels = regionLabels(region);
        const [labelX, labelY] = regionLabelAt(region);
        const [countX, countY] = regionCountAt(region);
        const texts = view.container.querySelectorAll("text");
        expect([
          Number(texts[0].getAttribute("x")),
          Number(texts[0].getAttribute("y")),
        ]).toEqual([labelX, labelY]);
        expect([
          Number(texts[1].getAttribute("x")),
          Number(texts[1].getAttribute("y")),
        ]).toEqual([countX, countY]);
        const countBox = textBox(
          countX,
          countY,
          `${total} parked · ${running} active`,
          18
        );
        const reserved = labels[1];
        expect(countBox.x0).toBeGreaterThanOrEqual(reserved.x0);
        expect(countBox.x1).toBeLessThanOrEqual(reserved.x1);
        expect(countBox.y0).toBe(reserved.y0);
        expect(countBox.y1).toBe(reserved.y1);
        expect(overlaps(labels[0], labels[1])).toBe(false);
        // A route/label obstacle at either drawn line is visible to geometry consumers.
        expect(labels.some((box) => overlaps(box, countBox))).toBe(true);
        const legacy = { ...region, liveHeader: undefined };
        expect(regionLabelAt(legacy)).toEqual([37, 47]);
        expect(regionLabels(legacy)).toHaveLength(1);
      } finally {
        view.unmount();
      }
    },
    { testCases: 40 }
  ));

it("Atlas count-bearing parts are unchanged full-scale neutral pictures without notes in every arrangement", () => {
  const input = fixture();
  const model = buildMachineFlow(input.summary, input.configs);
  const compiled = compileFlowOrThrow(model.spec);
  for (const diagram of compiled.arrangements)
    for (const p of diagram.parts) {
      expect(p.scale).toBe(1);
      expect(p.neutral).toBe(true);
      expect(p.change).toBe("unchanged");
      expect(p.changeNote).toBeUndefined();
      const count = textBox(24, 75, "99999 parked · 99999 active", 18);
      expect(partLabelsLocal(p).every((label) => !overlaps(label, count))).toBe(
        true
      );
    }
});

it.each([{ scale: 0.6 }, { change: "changed", changeNote: "Updated logic" }])(
  "other flows retain note/name geometry instead of drawing a count over it: %j",
  (overrides) => {
    const compiled = compileFlowOrThrow({
      version: 1,
      parts: [
        {
          id: "part",
          kind: "execute step",
          props: { topology: true },
          ...overrides,
        },
      ],
    });
    const diagram =
      compiled.arrangements.find((d) => d.parts[0].changeNote) ??
      compiled.arrangements[0];
    const view = render(
      <FlowScene
        diagram={diagram}
        t={0}
        reducedMotion
        interaction={{ onActivatePart: () => {} }}
        presentation={{ counts: new Map([["part", { total: 5, running: 2 }]]) }}
      />
    );
    expect(view.container.querySelector(".md-live-count")).toBeNull();
    expect(view.getByRole("button")).toHaveAccessibleName(/5 parked, 2 active/);
    if ("changeNote" in overrides)
      expect(view.getByText("Updated logic")).toBeInTheDocument();
  }
);

it("live-header reservation is opt-in validated compiler data", () => {
  const spec = {
    version: 1,
    parts: [{ id: "part", kind: "topology endpoint" }],
    regions: [{ id: "r", parts: ["part"], label: "Name", liveHeader: true }],
  };
  expect(compileFlowOrThrow(spec).arrangements[0].regions[0].liveHeader).toBe(
    true
  );
  expect(
    compileFlow({
      ...spec,
      regions: [{ ...spec.regions[0], liveHeader: "yes" }],
    }).ok
  ).toBe(false);
});

it("selected rings have a solid heavier stroke than traced neighbours in theme-independent CSS", () => {
  const rule = (selector: string) =>
    css.slice(css.indexOf(selector)).split("}")[0];
  const traced = rule("[data-scene-part][data-traced] .md-part-ring");
  const selected = rule("[data-scene-part][data-selected] .md-part-ring");
  expect(traced).toContain("stroke-dasharray: 8 6");
  expect(traced).toContain("stroke-width: 3");
  expect(selected).toContain("stroke-dasharray: none");
  expect(selected).toContain("stroke-width: 6");
});
