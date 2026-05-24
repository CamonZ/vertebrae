import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PanelHeader } from "./PanelHeader";

describe("PanelHeader", () => {
  it("renders title, metadata, and controls slots", () => {
    render(
      <PanelHeader
        title={<span>Implement JWT service</span>}
        metadata={<span>meta-row</span>}
        controls={<button type="button">Close</button>}
      />,
    );
    expect(screen.getByText("Implement JWT service")).toBeInTheDocument();
    expect(screen.getByText("meta-row")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Close" })).toBeInTheDocument();
  });

  it("skips metadata row when none provided", () => {
    const { container } = render(<PanelHeader title="x" />);
    // Only one row should render (the title row).
    expect(container.querySelectorAll("header > div").length).toBe(1);
  });
});
