import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { StepBadge } from "./StepBadge";

describe("StepBadge", () => {
  it("formats the step name with capitalization and spacing", () => {
    render(<StepBadge stepName="in_progress" />);
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

  it("uses a square radius and status color for done", () => {
    render(<StepBadge stepName="done" />);
    const badge = screen.getByText("Done");
    expect(badge.className).toContain("rounded-[var(--radius-sm)]");
    expect(badge.className).toContain("text-[var(--color-ok)]");
  });
});
