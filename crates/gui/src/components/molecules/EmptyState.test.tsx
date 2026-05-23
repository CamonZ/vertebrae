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
});
