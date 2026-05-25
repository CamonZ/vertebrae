import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmptyState } from "./EmptyState";

describe("EmptyState", () => {
  it("renders title and description", () => {
    render(
      <EmptyState title="No results" description="No tasks match the filter." />,
    );
    expect(screen.getByText("No results")).toBeInTheDocument();
    expect(screen.getByText("No tasks match the filter.")).toBeInTheDocument();
  });

  it("renders an action slot", () => {
    render(
      <EmptyState
        title="Quiet"
        action={<button type="button">Reset</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Reset" })).toBeInTheDocument();
  });

  it("renders the serif-italic em-dash editorial mark when no icon is given", () => {
    render(<EmptyState title="No results" />);
    const mark = screen.getByText("—");
    expect(mark).toHaveClass("font-serif", "italic");
  });

  it("does not render the em-dash mark when an icon is supplied", () => {
    render(<EmptyState icon={<svg data-testid="custom-icon" />} title="X" />);
    expect(screen.getByTestId("custom-icon")).toBeInTheDocument();
    expect(screen.queryByText("—")).not.toBeInTheDocument();
  });

  it("renders the description as muted weight-300 serif italic (lede role)", () => {
    render(<EmptyState description="No tasks match the filter." />);
    const desc = screen.getByText("No tasks match the filter.");
    expect(desc).toHaveClass("font-serif", "font-light", "italic");
    expect(desc).toHaveClass("text-[var(--color-fg-mute)]");
  });
});
