import { cleanup, fireEvent, render } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import Ajv from "ajv/dist/2020";
import {
  compileFlowLaidOut,
  compileFlowOrThrow,
  createFlowRegistry,
  labelCollisions,
  parseFlowSpec,
  partLabels,
  type FlowSpec,
} from "./index";
import { FlowScene } from "./FlowDiagram";
import { flowSpecJsonSchema } from "./jsonSchema";
import { validateFlowSpec } from "./validate";
import {
  SUBTITLE_PLACEMENTS,
  TITLE_PLACEMENTS,
  type PartLabels,
} from "../partLabels";

const registry = createFlowRegistry();
afterEach(cleanup);
const spec = (labels?: PartLabels): FlowSpec => ({
  version: 1,
  labels,
  parts: [
    { id: "worker", kind: "worker", label: "Worker name", job: "does a job" },
  ],
});
const modes = TITLE_PLACEMENTS.flatMap((title) =>
  SUBTITLE_PLACEMENTS.map((subtitle) => ({ title, subtitle }))
);

test.each(modes)(
  "renders $title / $subtitle at every scale and retains accessible identity",
  (labels) => {
    for (const scale of [0.5, 0.75, 1, 2]) {
      const s = spec(labels);
      const d = compileFlowOrThrow({
        ...s,
        parts: s.parts.map((p) => ({ ...p, scale })),
      }).arrangements[0];
      const v = render(<FlowScene diagram={d} t={0} reducedMotion />);
      const header = () => [
        ...v.container.querySelectorAll("[data-part-labels] text"),
      ];
      const text = () =>
        header()
          .map((t) => t.textContent)
          .join("");
      expect(text().includes("Worker name")).toBe(labels.title === "shown");
      expect(text().includes("does a job")).toBe(
        ["beside", "below"].includes(labels.subtitle)
      );
      expect(
        v.container.querySelector("[data-part-id]")?.getAttribute("aria-label")
      ).toContain("Worker name");
      expect(
        v.container.querySelector("[data-part-id]")?.getAttribute("aria-label")
      ).toContain("does a job");
      expect(
        header().every((t) => Number(t.getAttribute("font-size")) >= 18)
      ).toBe(true);
      if (labels.title === "shown" && labels.subtitle === "below")
        expect(header()[0].getAttribute("y")).not.toBe(
          header()[1].getAttribute("y")
        );
      if (labels.title === "shown" && labels.subtitle === "beside")
        expect(header()[0].getAttribute("y")).toBe(
          header()[1].getAttribute("y")
        );
      v.unmount();
    }
  }
);

test("per-part fields inherit independently, including hidden overrides", () => {
  const d = compileFlowOrThrow({
    ...spec({ title: "hidden", subtitle: "below" }),
    parts: [
      { id: "one", kind: "worker", labels: { title: "hover" } },
      { id: "two", kind: "worker", labels: { subtitle: "hidden" } },
    ],
  }).arrangements[0];
  expect(d.parts.map((p) => p.labels)).toEqual([
    { title: "hover", subtitle: "below" },
    { title: "hidden", subtitle: "hidden" },
  ]);
  const v = render(<FlowScene diagram={d} t={0} />);
  expect(
    v.container.querySelector('[data-part-labels="one"]')?.textContent
  ).toContain(d.parts[0].identity.job);
  expect(
    v.container.querySelector('[data-part-labels="two"]')?.textContent
  ).toBe("");
});

test("hover and focus reveal over the diagram without moving geometry or disabling activation", () => {
  const d = compileFlowOrThrow(spec({ title: "hover", subtitle: "hover" }))
    .arrangements[0];
  const before = JSON.stringify(d);
  let activated = "";
  const v = render(
    <FlowScene
      diagram={d}
      t={0}
      interaction={{
        onActivatePart: (id) => {
          activated = id;
        },
      }}
    />
  );
  const part = v.container.querySelector('[data-part-id="worker"]')!;
  const overlay = () => v.container.querySelector(".md-label-layer")!;
  expect(part).toHaveAttribute("tabindex", "0");
  expect(overlay().textContent).toBe("");
  fireEvent.mouseEnter(part);
  expect(overlay().textContent).toContain("Worker name");
  expect(overlay().textContent).toContain("does a job");
  fireEvent.focus(part);
  fireEvent.mouseLeave(part);
  expect(overlay().textContent).toContain("Worker name");
  fireEvent.keyDown(part, { key: "Enter" });
  expect(activated).toBe("worker");
  fireEvent.blur(part);
  expect(overlay().textContent).toBe("");
  fireEvent.mouseEnter(part);
  fireEvent.mouseLeave(part);
  expect(overlay().textContent).toBe("");
  expect(JSON.stringify(d)).toBe(before);
  expect(partLabels(d.parts[0])).toEqual([]);
});

test("hover-only parts are keyboard reachable without an activation handler", () => {
  const d = compileFlowOrThrow(spec({ subtitle: "hover" })).arrangements[0];
  const v = render(<FlowScene diagram={d} t={0} />);
  const p = v.container.querySelector("[data-part-id]")!;
  expect(p).toHaveAttribute("tabindex", "0");
  fireEvent.focus(p);
  expect(v.container.querySelector(".md-label-layer")?.textContent).toContain(
    "does a job"
  );
  fireEvent.blur(p);
  expect(v.container.querySelector(".md-label-layer")?.textContent).toBe("");
});

test("runtime and JSON-schema validation accept policies and reject malformed fields", () => {
  const schema = new Ajv({ strict: false, validateFormats: false }).compile(
    flowSpecJsonSchema(registry)
  );
  for (const labels of modes) {
    const s = spec(labels);
    expect(validateFlowSpec(s, registry)).toEqual([]);
    expect(schema(s)).toBe(true);
  }
  for (const labels of [
    null,
    false,
    "below",
    [],
    { title: "below" },
    { subtitle: "shown" },
    { extra: "hidden" },
  ]) {
    for (const s of [
      { ...spec(), labels },
      { ...spec(), parts: [{ id: "p", kind: "worker", labels }] },
    ]) {
      expect(validateFlowSpec(s, registry).length).toBeGreaterThan(0);
      expect(schema(s)).toBe(false);
    }
  }
});

const fixtures = import.meta.glob("./__fixtures__/*.flow.yaml", {
  query: "?raw",
  import: "default",
  eager: true,
});
for (const [name, source] of Object.entries(fixtures)) {
  test.each(["beside", "below", "hidden"] as const)(
    `${name}: %s labels clear frames, labels and rails`,
    async (subtitle) => {
      const parsed = parseFlowSpec(source as string);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.errors));
      const s = parsed.value as FlowSpec;
      const laid = await compileFlowLaidOut({
        ...s,
        labels: { title: subtitle === "hidden" ? "hidden" : "shown", subtitle },
        parts: s.parts.map((p) => ({ ...p, position: undefined })),
      });
      if (!laid.ok) throw new Error(JSON.stringify(laid.errors));
      for (const d of laid.flow.arrangements) {
        expect(labelCollisions(d)).toEqual([]);
        const labels = d.parts.flatMap(partLabels);
        for (const r of d.rails.filter((r) => r.presence !== "absent")) {
          for (let i = 1; i < r.points.length; i++) {
            const [a, b] = [r.points[i - 1], r.points[i]];
            for (const l of labels) {
              const crosses =
                Math.min(a[0], b[0]) < l.x1 &&
                Math.max(a[0], b[0]) > l.x0 &&
                Math.min(a[1], b[1]) < l.y1 &&
                Math.max(a[1], b[1]) > l.y0;
              expect(crosses, `${r.id} crosses ${l.owner}: ${l.text}`).toBe(
                false
              );
            }
          }
        }
      }
    },
    60000
  );
}
