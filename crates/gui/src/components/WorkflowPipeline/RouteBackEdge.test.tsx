import { describe, expect, it } from "vitest";
import { render, screen } from "../../test/test-utils";
import { RouteBackEdge, type RouteBackEdgeType } from "./RouteBackEdge";
import { Position, type EdgeProps } from "@xyflow/react";

function createRouteBackEdgeProps(
  overrides?: Partial<EdgeProps<RouteBackEdgeType>>
): EdgeProps<RouteBackEdgeType> {
  return {
    id: "edge-route-back",
    source: "route-step",
    target: "todo-step",
    sourceX: 240,
    sourceY: 80,
    targetX: 40,
    targetY: 40,
    sourcePosition: Position.Right,
    targetPosition: Position.Left,
    data: {},
    selected: false,
    animated: false,
    deletable: true,
    selectable: true,
    markerEnd: "url(#arrow-closed)",
    style: {
      stroke: "rgb(34, 197, 94)",
      strokeDasharray: "6 4",
    },
    ...overrides,
  };
}

describe("RouteBackEdge", () => {
  it("renders a loop edge with interaction path, dashed body, and solid marker tail", () => {
    const props = createRouteBackEdgeProps();

    const { container } = render(
      <svg>
        <RouteBackEdge {...props} />
      </svg>
    );

    const group = screen.getByTestId("route-back-edge");
    expect(group).toBeInTheDocument();
    expect(group).toHaveAttribute("data-edgeid", "edge-route-back");

    const interactionPath = group.querySelector(
      "path.react-flow__edge-interaction"
    );
    expect(interactionPath).toBeInTheDocument();
    expect(interactionPath).toHaveAttribute("stroke", "transparent");
    expect(interactionPath).toHaveAttribute("stroke-width", "20");
    expect(interactionPath).toHaveAttribute("fill", "none");
    expect(interactionPath).toHaveAttribute(
      "d",
      "M 164 165 L 164 245 L 148 261 L 202 261 L 186 245 L 186 125"
    );
    expect(interactionPath).toHaveStyle({ pointerEvents: "stroke" });

    const bodyPath = container.querySelector("#edge-route-back");
    expect(bodyPath).toBeInTheDocument();
    expect(bodyPath).toHaveAttribute(
      "d",
      "M 164 165 L 164 245 L 148 261 L 202 261 L 186 245 L 186 135"
    );
    expect(bodyPath).toHaveStyle({ stroke: "rgb(34, 197, 94)" });
    expect(bodyPath).toHaveStyle({ strokeDasharray: "6 4" });

    const tailPath = container.querySelector("#edge-route-back-tail");
    expect(tailPath).toBeInTheDocument();
    expect(tailPath).toHaveAttribute("d", "M 186 135 L 186 125");
    expect(tailPath).toHaveAttribute("marker-end", "url(#arrow-closed)");
    expect(tailPath).toHaveStyle({ stroke: "rgb(34, 197, 94)" });
    expect(tailPath).toHaveStyle({ strokeDasharray: "" });

    const destinationArrow = screen.getByTestId("route-back-destination-arrow");
    expect(destinationArrow).toHaveAttribute(
      "d",
      "M 186 125 L 191 134 L 181 134 Z"
    );
    expect(destinationArrow).toHaveAttribute("fill", "rgb(34, 197, 94)");
    expect(destinationArrow).toHaveAttribute("stroke", "none");
  });

  it("offsets loop geometry when a loop lane is provided", () => {
    const props = createRouteBackEdgeProps({
      data: { loopLane: 2 },
    });

    render(
      <svg>
        <RouteBackEdge {...props} />
      </svg>
    );

    const group = screen.getByTestId("route-back-edge");
    const interactionPath = group.querySelector(
      "path.react-flow__edge-interaction"
    );
    expect(interactionPath).toHaveAttribute(
      "d",
      "M 116 165 L 116 301 L 100 317 L 250 317 L 234 301 L 234 125"
    );
  });

  it("routes top-side loop geometry when requested", () => {
    const props = createRouteBackEdgeProps({
      data: { loopLane: 1, loopSide: "top" },
    });

    render(
      <svg>
        <RouteBackEdge {...props} />
      </svg>
    );

    const group = screen.getByTestId("route-back-edge");
    const interactionPath = group.querySelector(
      "path.react-flow__edge-interaction"
    );
    expect(interactionPath).toHaveAttribute(
      "d",
      "M 140 -5 L 140 -153 L 124 -169 L 226 -169 L 210 -153 L 210 -45"
    );
  });
});
