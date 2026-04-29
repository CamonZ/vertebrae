import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { TransitionMarker } from "./TransitionMarker";

describe("TransitionMarker", () => {
  it("renders humanized from/to step labels", () => {
    render(
      <TransitionMarker
        fromStep="implementation_in_progress"
        toStep="pending_review"
        taskId="t-1"
      />
    );
    const marker = screen.getByTestId("unified-chat-transition");
    expect(marker.getAttribute("data-task-id")).toBe("t-1");
    expect(marker.getAttribute("data-from-step")).toBe(
      "implementation_in_progress"
    );
    expect(marker.getAttribute("data-to-step")).toBe("pending_review");
    expect(screen.getByText("implementation in progress")).toBeInTheDocument();
    expect(screen.getByText("pending review")).toBeInTheDocument();
  });

  it("falls back to '?' when a step name is null", () => {
    render(<TransitionMarker fromStep={null} toStep={null} taskId="t" />);
    const qmarks = screen.getAllByText("?");
    expect(qmarks).toHaveLength(2);
  });
});
