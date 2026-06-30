import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThinkingIndicator } from "./ThinkingIndicator";

describe("ThinkingIndicator", () => {
  it("renders the 'Thinking...' text", () => {
    render(<ThinkingIndicator />);
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("renders three bouncing dots", () => {
    const { container } = render(<ThinkingIndicator />);
    const dots = container.querySelectorAll(".animate-bounce");
    expect(dots).toHaveLength(3);
  });
});
