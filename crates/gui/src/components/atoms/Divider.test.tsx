import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Divider } from "./Divider";

describe("Divider", () => {
  it("renders an hr without a label", () => {
    render(<Divider />);
    const sep = screen.getByRole("separator");
    expect(sep.tagName).toBe("HR");
  });

  it("centers a label between two rules", () => {
    render(<Divider label="OR" />);
    expect(screen.getByText("OR")).toBeInTheDocument();
  });

  it("supports vertical orientation", () => {
    render(<Divider orientation="vertical" />);
    expect(screen.getByRole("separator")).toHaveAttribute(
      "aria-orientation",
      "vertical",
    );
  });
});
