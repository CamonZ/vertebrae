import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThinkingIndicator } from "./ThinkingIndicator";
import {
  getThinkingRadialBand,
  THINKING_ALMOND_MASK,
} from "./thinkingIndicatorGeometry";
import {
  FUTURISTIC_COMPACTING_ACTIONS,
  FUTURISTIC_COMPACTING_PHRASES,
  FUTURISTIC_THINKING_PHRASES,
} from "./thinkingPhrases";

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

  it("renders an 8x5 concentric-ring field of 4px lights", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    render(<ThinkingIndicator style="futuristic" />);
    const status = screen.getByRole("status");

    expect(screen.getByTestId("thinking-indicator")).toHaveAttribute(
      "data-style",
      "futuristic"
    );
    const matrix = screen.getByTestId("thinking-matrix");
    expect(matrix).toHaveAttribute("data-animation-direction", "outward");
    const lights = Array.from(
      matrix.querySelectorAll<HTMLElement>(".thinking-matrix__light")
    );
    expect(lights).toHaveLength(40);
    expect(matrix).toHaveClass("grid-cols-8", "grid-rows-5", "gap-px");
    expect(matrix).toHaveAttribute("data-shape", "wide-almond");
    expect(matrix.parentElement).toHaveClass("pl-2", "pr-4", "py-2");
    expect(lights.every((light) => light.classList.contains("h-[4px]"))).toBe(
      true
    );
    expect(lights.every((light) => light.classList.contains("w-[4px]"))).toBe(
      true
    );
    expect(
      lights.every((light) => light.classList.contains("rounded-full"))
    ).toBe(true);
    const mask = THINKING_ALMOND_MASK.join("");
    expect(
      lights.map((light) =>
        light.classList.contains("thinking-matrix__light--inside") ? "X" : "."
      )
    ).toEqual([...mask]);
    expect(
      lights.filter((light) =>
        light.classList.contains("thinking-matrix__light--inside")
      )
    ).toHaveLength(24);
    expect(
      lights.filter((light) =>
        light.classList.contains("thinking-matrix__light--outside")
      )
    ).toHaveLength(16);
    expect(
      lights.every((light) =>
        light.classList.contains("motion-reduce:animate-none")
      )
    ).toBe(true);

    expect(new Set(lights.map((light) => light.dataset.radialBand))).toEqual(
      new Set(["0", "1", "2", "3", "4"])
    );
    expect(FUTURISTIC_THINKING_PHRASES).toHaveLength(100);
    expect(FUTURISTIC_THINKING_PHRASES).toContain(status.textContent);
    expect(status).toHaveAttribute("aria-live", "polite");
    expect(status).toHaveAttribute("aria-atomic", "true");

    random.mockRestore();
  });

  it("assigns radial timing from the center outward", () => {
    render(<ThinkingIndicator style="futuristic" />);
    const matrix = screen.getByTestId("thinking-matrix");
    const getLight = (row: number, column: number) =>
      matrix.querySelector<HTMLElement>(
        `[data-row="${row}"][data-column="${column}"]`
      );

    const center = getLight(2, 3);
    const nextBand = getLight(2, 2);
    const corner = getLight(0, 0);
    const oppositeCorner = getLight(4, 7);
    const otherCenter = getLight(2, 4);

    expect(getThinkingRadialBand(2, 3)).toBe(0);
    expect(getThinkingRadialBand(2, 2)).toBe(1);
    expect(getThinkingRadialBand(0, 0)).toBe(4);
    expect(center).toHaveAttribute("data-radial-band", "0");
    expect(center).toHaveClass("thinking-matrix__light--gray");
    expect(otherCenter).toHaveClass("thinking-matrix__light--gray");
    expect(nextBand).toHaveAttribute("data-radial-band", "1");
    expect(corner).toHaveAttribute("data-radial-band", "4");
    expect(center?.style.animationDelay).toBe("0s");
    expect(nextBand?.style.animationDelay).toBe("0.12s");
    expect(corner?.style.animationDelay).toBe("0.48s");
    expect(oppositeCorner?.style.animationDelay).toBe("0.48s");
  });

  it("keeps a futuristic thinking phrase stable across rerenders", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const { rerender } = render(<ThinkingIndicator style="futuristic" />);
    const phrase = screen.getByRole("status").textContent;

    random.mockReturnValue(0.99);
    rerender(<ThinkingIndicator style="futuristic" />);
    expect(screen.getByRole("status")).toHaveTextContent(phrase ?? "");
    random.mockRestore();
  });

  it("uses a stable themed phrase while futuristically compacting", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const { rerender } = render(
      <ThinkingIndicator style="futuristic" label="Compacting conversation…" />
    );
    const status = screen.getByRole("status");
    const phrase = status.textContent;

    expect(FUTURISTIC_COMPACTING_PHRASES).toHaveLength(50);
    expect(FUTURISTIC_COMPACTING_PHRASES).toContain(phrase);
    expect(
      FUTURISTIC_COMPACTING_PHRASES.every((compactingPhrase) =>
        FUTURISTIC_COMPACTING_ACTIONS.some((action) =>
          compactingPhrase.startsWith(`${action} `)
        )
      )
    ).toBe(true);
    expect(
      FUTURISTIC_THINKING_PHRASES.every(
        (thinkingPhrase) =>
          !FUTURISTIC_COMPACTING_ACTIONS.some((action) =>
            thinkingPhrase.startsWith(`${action} `)
          )
      )
    ).toBe(true);
    expect(phrase).not.toBe("Compacting conversation…");
    expect(status).toHaveAccessibleName(phrase ?? "");

    random.mockReturnValue(0.99);
    rerender(
      <ThinkingIndicator style="futuristic" label="Compacting conversation…" />
    );
    expect(screen.getByRole("status")).toHaveTextContent(phrase ?? "");
    random.mockRestore();
  });

  it("reverses radial timing inward while futuristically compacting", () => {
    render(
      <ThinkingIndicator style="futuristic" label="Compacting conversation…" />
    );
    const matrix = screen.getByTestId("thinking-matrix");
    const getLight = (row: number, column: number) =>
      matrix.querySelector<HTMLElement>(
        `[data-row="${row}"][data-column="${column}"]`
      );

    const center = getLight(2, 3);
    const nextBand = getLight(2, 2);
    const outer = getLight(0, 0);

    expect(matrix).toHaveAttribute("data-animation-direction", "inward");
    expect(center?.style.animationDelay).toBe("0.48s");
    expect(nextBand?.style.animationDelay).toBe("0.36s");
    expect(outer?.style.animationDelay).toBe("0s");
  });

  it("preserves semantic activity labels for stopping and classic compaction", () => {
    render(
      <>
        <ThinkingIndicator style="futuristic" label="Stopping..." />
        <ThinkingIndicator label="Compacting conversation…" />
      </>
    );

    expect(screen.getAllByRole("status")[0]).toHaveAccessibleName(
      "Stopping..."
    );
    expect(screen.getAllByRole("status")[1]).toHaveAccessibleName(
      "Compacting conversation…"
    );
  });

  it("marks animated elements for reduced-motion presentation", () => {
    const { container } = render(<ThinkingIndicator style="futuristic" />);

    expect(
      container.querySelector(".thinking-matrix__light--inside")
    ).toHaveClass(
      "h-[4px]",
      "w-[4px]",
      "rounded-full",
      "motion-reduce:animate-none"
    );
  });
});
