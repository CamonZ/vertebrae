import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepBadge } from "./StepBadge";

describe("StepBadge", () => {
  it("formats the step name with capitalization and spacing", () => {
    render(<StepBadge stepName="in_progress" stepType="execute" />);
    expect(screen.getByText("In progress")).toBeInTheDocument();
  });

  it("renders the default empty label when stepName is null", () => {
    render(<StepBadge stepName={null} />);
    expect(screen.getByText("No step")).toBeInTheDocument();
  });

  it("honors a custom empty label", () => {
    render(<StepBadge stepName={null} emptyLabel="—" />);
    expect(screen.getByText("—")).toBeInTheDocument();
  });

  it("uses a square radius and typed step color independent of the display label", () => {
    render(<StepBadge stepName="done" stepType="evaluate" />);
    const badge = screen.getByText("Done");
    expect(badge.className).toContain("rounded-[var(--radius-sm)]");
    expect(badge.getAttribute("style")).toContain("--color-step-eval-fg");
  });

  it("uses run status color ahead of step type when a run is present", () => {
    render(
      <StepBadge stepName="review" stepType="evaluate" runStatus="failed" />
    );
    const badge = screen.getByText("Review");
    expect(badge.getAttribute("style")).toContain("--color-err");
  });
});
