import { Position, type EdgeProps } from "@xyflow/react";
import { describe, expect, it } from "vitest";
import { render, screen } from "../../test/test-utils";
import { ElkRoutedEdge, type ElkRoutedEdgeType } from "./ElkRoutedEdge";

function createElkRoutedEdgeProps(
  overrides?: Partial<EdgeProps<ElkRoutedEdgeType>>
): EdgeProps<ElkRoutedEdgeType> {
  return {
    id: "workflow-transition-a-b",
    source: "workflow-a",
    target: "workflow-b",
    sourceX: 10,
    sourceY: 20,
    targetX: 110,
    targetY: 80,
    sourcePosition: Position.Bottom,
    targetPosition: Position.Top,
    data: {
      sourcePoint: { x: 20, y: 30 },
      targetPoint: { x: 120, y: 90 },
      bendPoints: [{ x: 120, y: 30 }],
    },
    selected: false,
    animated: false,
    deletable: true,
    selectable: true,
    markerEnd: "url(#transition-arrow)",
    style: {
      stroke: "rgb(161, 161, 161)",
      strokeDasharray: "5,5",
    },
    ...overrides,
  };
}

describe("ElkRoutedEdge", () => {
  it("renders a destination arrow at the workflow transition target", () => {
    const props = createElkRoutedEdgeProps();

    render(
      <svg>
        <ElkRoutedEdge {...props} />
      </svg>
    );

    const destinationArrow = screen.getByTestId(
      "workflow-transition-destination-arrow"
    );
    expect(destinationArrow).toHaveAttribute(
      "d",
      "M 120 90 L 115 81 L 125 81 Z"
    );
    expect(destinationArrow).toHaveAttribute("fill", "rgb(161, 161, 161)");
    expect(destinationArrow).toHaveAttribute("stroke", "none");
  });
});
