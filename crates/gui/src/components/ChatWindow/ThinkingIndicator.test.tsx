import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThinkingIndicator } from "./ThinkingIndicator";
import { FUTURISTIC_THINKING_PHRASES } from "./thinkingPhrases";

describe("ThinkingIndicator", () => {
  it("renders the 'Thinking...' text", () => {
    render(<ThinkingIndicator />);
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("renders three bouncing dots", () => {
    const { container } = render(<ThinkingIndicator />);
    const dots = container.querySelectorAll(".animate-bounce");
    expect(dots).toHaveLength(3);
    expect(screen.getByRole("status")).toHaveAccessibleName("Thinking...");
  });

  it("renders a staggered futuristic matrix with a stable curated phrase", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const { rerender } = render(<ThinkingIndicator style="futuristic" />);
    const status = screen.getByRole("status");

    expect(screen.getByTestId("thinking-indicator")).toHaveAttribute(
      "data-style",
      "futuristic"
    );
    const matrix = screen.getByTestId("thinking-matrix");
    expect(matrix.children).toHaveLength(24);
    expect(matrix).toHaveClass("grid-cols-4");
    expect(matrix).not.toHaveClass("gap-px");
    expect(matrix.parentElement).toHaveClass("pl-2", "pr-4", "py-2");
    expect(
      matrix.querySelectorAll(".thinking-matrix__light--orange")
    ).toHaveLength(4);
    expect(
      matrix.querySelectorAll(".thinking-matrix__light--purple")
    ).toHaveLength(4);
    expect(
      matrix.querySelectorAll(".thinking-matrix__light--red")
    ).toHaveLength(4);
    expect(
      matrix.querySelectorAll(".thinking-matrix__light--gray-dark")
    ).toHaveLength(3);
    expect(
      matrix.querySelectorAll(".thinking-matrix__light--gray")
    ).toHaveLength(3);
    expect(
      matrix.querySelectorAll(".thinking-matrix__light--gray-light")
    ).toHaveLength(3);
    expect(
      matrix.querySelectorAll(".thinking-matrix__light--gray-bright")
    ).toHaveLength(3);
    expect(FUTURISTIC_THINKING_PHRASES).toHaveLength(60);
    expect(FUTURISTIC_THINKING_PHRASES).toContain(status.textContent);
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");

    const phrase = status.textContent;
    random.mockReturnValue(0.99);
    rerender(<ThinkingIndicator style="futuristic" />);
    expect(screen.getByRole("status")).toHaveTextContent(phrase ?? "");
    random.mockRestore();
  });

  it("preserves semantic activity labels for special waiting states", () => {
    render(
      <ThinkingIndicator style="futuristic" label="Compacting conversation…" />
    );

    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Compacting conversation…"
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Compacting conversation…"
    );
  });

  it("marks animated elements for reduced-motion presentation", () => {
    const { container } = render(<ThinkingIndicator style="futuristic" />);

    expect(container.querySelector(".thinking-matrix__light")).toHaveClass(
      "h-[5px]",
      "w-[5px]",
      "motion-reduce:animate-none"
    );
  });
});
