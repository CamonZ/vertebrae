import { describe, expect, it } from "vitest";
import { render } from "../../test/test-utils";
import { GraphEdge, type GraphEdgeKind } from "./GraphEdge";

function renderEdge(props: Parameters<typeof GraphEdge>[0]) {
  const { container } = render(
    <svg>
      <GraphEdge {...props} />
    </svg>
  );
  const path = container.querySelector("path");
  if (!path) throw new Error("GraphEdge did not render a <path>");
  return path;
}

describe("GraphEdge", () => {
  it("renders the routed path d through to the <path>", () => {
    const path = renderEdge({ d: "M0,0 L10,10" });
    expect(path).toHaveAttribute("d", "M0,0 L10,10");
  });

  it("never inlines a stroke color, width, dash, or opacity (token-driven only)", () => {
    const path = renderEdge({ d: "M0,0 L1,1", kind: "handoff", state: "lit" });
    // Styling must come from the .gedge token classes, not inline attributes.
    expect(path).not.toHaveAttribute("stroke");
    expect(path).not.toHaveAttribute("stroke-width");
    expect(path).not.toHaveAttribute("stroke-dasharray");
    expect(path).not.toHaveAttribute("stroke-opacity");
    expect(path.getAttribute("style") ?? "").toBe("");
  });

  describe("kind → class wiring", () => {
    const cases: { kind: GraphEdgeKind; cls: string }[] = [
      { kind: "step", cls: "k-step" },
      { kind: "handoff", cls: "k-handoff" },
      { kind: "loop", cls: "k-loop" },
    ];
    it.each(cases)("kind=$kind carries .gedge.$cls", ({ kind, cls }) => {
      const path = renderEdge({ d: "M0,0 L1,1", kind });
      expect(path).toHaveClass("gedge");
      expect(path).toHaveClass(cls);
    });

    it("defaults to the step kind", () => {
      const path = renderEdge({ d: "M0,0 L1,1" });
      expect(path).toHaveClass("k-step");
    });
  });

  describe("state → class wiring", () => {
    it("base state carries neither lit nor dim", () => {
      const path = renderEdge({ d: "M0,0 L1,1", kind: "handoff" });
      expect(path).not.toHaveClass("lit");
      expect(path).not.toHaveClass("dim");
    });

    it("lit state adds .lit", () => {
      const path = renderEdge({ d: "M0,0 L1,1", kind: "handoff", state: "lit" });
      expect(path).toHaveClass("k-handoff");
      expect(path).toHaveClass("lit");
    });

    it("dim state adds .dim", () => {
      const path = renderEdge({ d: "M0,0 L1,1", kind: "step", state: "dim" });
      expect(path).toHaveClass("dim");
    });

    it("back edges add .back", () => {
      const path = renderEdge({
        d: "M0,0 L1,1",
        kind: "handoff",
        state: "lit",
        back: true,
      });
      expect(path).toHaveClass("back");
    });
  });

  describe("markers", () => {
    it("loop edges default to the route-hued #ge-loop marker", () => {
      const path = renderEdge({ d: "M0,0 L1,1", kind: "loop" });
      expect(path).toHaveAttribute("marker-end", "url(#ge-loop)");
    });

    it("step and handoff edges default to the context-stroke #ge-arrow marker", () => {
      expect(renderEdge({ d: "M0,0 L1,1", kind: "step" })).toHaveAttribute(
        "marker-end",
        "url(#ge-arrow)"
      );
      expect(renderEdge({ d: "M0,0 L1,1", kind: "handoff" })).toHaveAttribute(
        "marker-end",
        "url(#ge-arrow)"
      );
    });

    it("a lit back edge uses the white #ge-arrow-back marker (over loop/lit)", () => {
      expect(
        renderEdge({ d: "M0,0 L1,1", kind: "handoff", state: "lit", back: true })
      ).toHaveAttribute("marker-end", "url(#ge-arrow-back)");
      // back wins even for loop edges when lit
      expect(
        renderEdge({ d: "M0,0 L1,1", kind: "loop", state: "lit", back: true })
      ).toHaveAttribute("marker-end", "url(#ge-arrow-back)");
    });

    it("a back edge only recolors its marker once lit (resting/dim unaffected)", () => {
      expect(
        renderEdge({ d: "M0,0 L1,1", kind: "loop", back: true })
      ).toHaveAttribute("marker-end", "url(#ge-loop)");
      expect(
        renderEdge({ d: "M0,0 L1,1", kind: "handoff", state: "dim", back: true })
      ).toHaveAttribute("marker-end", "url(#ge-arrow-dim)");
    });

    it("an explicit markerEnd overrides the kind default", () => {
      const path = renderEdge({
        d: "M0,0 L1,1",
        kind: "loop",
        markerEnd: "url(#custom)",
      });
      expect(path).toHaveAttribute("marker-end", "url(#custom)");
    });

    it("markerEnd=null omits the arrowhead", () => {
      const path = renderEdge({ d: "M0,0 L1,1", markerEnd: null });
      expect(path).not.toHaveAttribute("marker-end");
    });
  });

  describe("modifiers", () => {
    it("solid forces a handoff to render without a dash via .solid", () => {
      const path = renderEdge({ d: "M0,0 L1,1", kind: "handoff", solid: true });
      expect(path).toHaveClass("k-handoff");
      expect(path).toHaveClass("solid");
    });

    it("live renders the animated variant and an <animate> child", () => {
      const { container } = render(
        <svg>
          <GraphEdge d="M0,0 L1,1" live />
        </svg>
      );
      const path = container.querySelector("path");
      expect(path).toHaveClass("gedge");
      expect(path).toHaveClass("live");
      expect(path?.querySelector("animate")).toHaveAttribute(
        "attributeName",
        "stroke-dashoffset"
      );
    });
  });
});
