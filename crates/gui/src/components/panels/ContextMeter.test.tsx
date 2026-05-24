import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { ContextMeter } from "./ContextMeter";

describe("ContextMeter", () => {
  it("renders nothing when max is missing or zero", () => {
    const { container, rerender } = render(
      <ContextMeter used={10} max={undefined} />,
    );
    expect(container.firstChild).toBeNull();
    rerender(<ContextMeter used={10} max={0} />);
    expect(container.firstChild).toBeNull();
  });

  it("reports percentage as aria-valuenow", () => {
    render(<ContextMeter used={50} max={200} />);
    const bar = screen.getByRole("progressbar");
    expect(bar).toHaveAttribute("aria-valuenow", "25");
  });

  it("clamps to 100 when used exceeds max", () => {
    render(<ContextMeter used={500} max={100} />);
    expect(screen.getByRole("progressbar")).toHaveAttribute(
      "aria-valuenow",
      "100",
    );
  });
});
