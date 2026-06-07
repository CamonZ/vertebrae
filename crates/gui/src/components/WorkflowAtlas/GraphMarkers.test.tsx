import { describe, expect, it } from "vitest";
import { render } from "../../test/test-utils";
import { GraphMarkers } from "./GraphMarkers";

function renderMarkers() {
  const { container } = render(
    <svg>
      <GraphMarkers />
    </svg>
  );
  return container;
}

describe("GraphMarkers", () => {
  it("defines the per-state arrow markers + the loop marker GraphEdge references", () => {
    const container = renderMarkers();
    expect(container.querySelector("marker#ge-arrow")).toBeTruthy();
    expect(container.querySelector("marker#ge-arrow-lit")).toBeTruthy();
    expect(container.querySelector("marker#ge-arrow-back")).toBeTruthy();
    expect(container.querySelector("marker#ge-arrow-dim")).toBeTruthy();
    expect(container.querySelector("marker#ge-loop")).toBeTruthy();
  });

  it("ge-arrow-back is pinned to the back-edge token (max-contrast white)", () => {
    const backHead = renderMarkers().querySelector("#ge-arrow-back path");
    expect(backHead).toHaveAttribute("fill", "var(--edge-color-back)");
  });

  it("pins arrowheads to explicit visible token colors per state (not context-stroke)", () => {
    const container = renderMarkers();
    // context-stroke falls back to black in the macOS WebKit WebView, so each
    // state carries an explicit, visible token fill instead.
    expect(container.querySelector("#ge-arrow path")).toHaveAttribute(
      "fill",
      "var(--fg-mute)",
    );
    expect(container.querySelector("#ge-arrow-lit path")).toHaveAttribute(
      "fill",
      "var(--edge-color-lit)",
    );
    expect(
      container.querySelector("#ge-arrow path")?.getAttribute("fill"),
    ).not.toBe("context-stroke");
  });

  it("ge-loop is pinned to the route-hue token, not a literal color", () => {
    const loopHead = renderMarkers().querySelector("#ge-loop path");
    expect(loopHead).toHaveAttribute("fill", "var(--step-route)");
  });

  it("both markers orient with auto-start-reverse so they point along the edge", () => {
    const container = renderMarkers();
    expect(container.querySelector("#ge-arrow")).toHaveAttribute(
      "orient",
      "auto-start-reverse"
    );
    expect(container.querySelector("#ge-loop")).toHaveAttribute(
      "orient",
      "auto-start-reverse"
    );
  });
});
