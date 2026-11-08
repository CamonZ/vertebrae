import { readFileSync } from "node:fs";
import { fireEvent, render, screen } from "@testing-library/react";
import { expect, it } from "vitest";
import { StatechartPreview } from "./StatechartPreview";

const doc = readFileSync(
  "../../docs/agent-context/statecharts-example.md",
  "utf8"
);
const body = doc.match(/```json\n([\s\S]*?)\n```/)![1];

it("renders the real native SVG with parallel regions, final markers and selectable state details", async () => {
  const ui = render(<StatechartPreview body={body} />);
  const diagram = await screen.findByRole("group", {
    name: "Ticket delivery statechart",
  });
  const verify = screen.getByRole("button", {
    name: "Inspect Verify parallel state",
  });
  const done = screen.getByRole("button", { name: "Inspect Done final state" });
  const oldWidth = diagram.getAttribute("width");
  const zoom = screen.getByRole("button", { name: "Zoom in statechart" });

  expect(ui.container.querySelector("iframe")).toBeNull();
  expect(
    ui.container.querySelectorAll('[data-state-type="parallel"]')
  ).toHaveLength(1);
  expect(
    ui.container.querySelectorAll('[aria-label="Final state marker"]')
  ).toHaveLength(3);
  expect(ui.container.querySelectorAll("[data-transition-id]")).toHaveLength(
    11
  );

  fireEvent.click(verify);

  const inspector = screen.getByTestId("statechart-inspection");

  expect(inspector).toHaveTextContent("delivery.Work.Verify · parallel");
  expect(inspector).toHaveTextContent("All child regions are active together.");
  expect(verify).toHaveAttribute("aria-pressed", "true");

  const boundary = verify.querySelector("[data-state-boundary]");
  const viewer = screen.getByTestId("statechart-viewer");
  const resize = screen.getByRole("separator", { name: "Resize statechart" });

  expect(boundary).toHaveAttribute("stroke", "var(--color-fg-soft)");
  expect(boundary).toHaveAttribute("stroke-width", "2");
  expect(viewer).toHaveStyle({
    width: "90%",
    maxWidth: "90%",
    marginInline: "auto",
  });
  expect(resize).toHaveClass("evdiff-handle");

  fireEvent.click(zoom);

  expect(diagram.getAttribute("width")).not.toBe(oldWidth);

  fireEvent.keyDown(done, { key: "Enter" });

  expect(inspector).toHaveTextContent("delivery.Done · final");
});

it("treats artifact descriptions as text without inserting HTML", async () => {
  const definition = {
    id: "safe",
    description: '<img src=x onerror="alert(1)">',
    initial: "idle",
    states: { idle: {} },
  };
  const source = JSON.stringify(definition);
  const ui = render(<StatechartPreview body={source} />);
  const diagram = await screen.findByRole("group");

  expect(diagram).toHaveAttribute(
    "aria-label",
    `${definition.description} statechart`
  );
  expect(ui.container.querySelector("img")).toBeNull();
  expect(ui.container.querySelector("script")).toBeNull();
});

it("keeps event colors and matching arrowheads when selecting states, with an optional single color", async () => {
  const ui = render(<StatechartPreview body={body} />);
  await screen.findByRole("group", { name: "Ticket delivery statechart" });

  const paths = [
    ...ui.container.querySelectorAll<SVGPathElement>(
      "[data-transition-id]:not([data-initial]) > path"
    ),
  ];
  const colors = paths.map((path) => path.getAttribute("stroke"));

  const distinctColors = new Set(colors);

  expect(distinctColors.size).toBe(7);
  expect(screen.getByLabelText("Transition color legend")).toHaveTextContent(
    "READY"
  );

  for (const path of paths) {
    const markerReference = path.getAttribute("marker-end")!;
    const markerId = markerReference.slice(5, -1);
    const marker = document.getElementById(markerId)!;
    const arrow = marker.querySelector("path")!;

    expect(arrow.getAttribute("stroke")).toBe(path.getAttribute("stroke"));
  }

  fireEvent.click(
    screen.getByRole("button", { name: "Inspect Verify parallel state" })
  );

  const selectedColors = paths.map((path) => path.getAttribute("stroke"));

  expect(selectedColors).toEqual(colors);

  fireEvent.change(screen.getByLabelText("Transition colors"), {
    target: { value: "single" },
  });

  const singleColors = paths.map((path) => path.getAttribute("stroke"));
  const distinctSingleColors = new Set(singleColors);

  expect(distinctSingleColors.size).toBe(1);
  expect(screen.queryByLabelText("Transition color legend")).toBeNull();
});
