import { afterEach, describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import { ThinkingIndicator } from "./ThinkingIndicator";
import {
  FUTURISTIC_COMPACTING_ACTIONS,
  FUTURISTIC_COMPACTING_PHRASES,
  FUTURISTIC_THINKING_PHRASES,
} from "./thinkingPhrases";

// jsdom has no WebGL2: stand in for the shared renderer so the shader-line
// styles mount their canvas; `gpu.available = false` exercises the fallback.
const gpu = vi.hoisted(() => ({ available: true }));
vi.mock("../ThinkingLine/renderer", () => ({
  getThinkingLineRenderer: () => ({
    subscribe: () => () => {},
    isAvailable: () => gpu.available,
    attach: () => ({
      update() {},
      resize() {},
      setVisible() {},
      dispose() {},
    }),
  }),
}));

describe("ThinkingIndicator", () => {
  afterEach(() => {
    gpu.available = true;
  });

  it.each(["shimmer", "uplink", "assembler"] as const)(
    "shows the %s status as visible text when WebGL2 is unavailable",
    (style) => {
      gpu.available = false;
      vi.spyOn(Math, "random").mockReturnValue(0);
      render(<ThinkingIndicator style={style} />);
      const statusLabel = screen.getByRole("status").getAttribute("aria-label");
      expect(screen.queryByTestId("thinking-line")).not.toBeInTheDocument();
      const fallback = screen.getByTestId("thinking-line-fallback");
      expect(fallback).toHaveTextContent(statusLabel!);
      expect(fallback).toBeVisible();
      vi.mocked(Math.random).mockRestore();
    }
  );

  it.each(["shimmer", "uplink", "assembler"] as const)(
    "falls back to a hairline in the compact %s badge",
    (style) => {
      gpu.available = false;
      render(<ThinkingIndicator style={style} compact />);
      const fallback = screen.getByTestId("thinking-line-fallback");
      expect(fallback).toHaveTextContent("");
      expect(fallback).toHaveStyle({ width: "40px", height: "10px" });
      expect(screen.getByRole("status")).toHaveAccessibleName(/\S/);
    }
  );

  it("renders the 'Thinking...' text", () => {
    render(<ThinkingIndicator />);
    expect(screen.getByText("Thinking...")).toBeInTheDocument();
  });

  it("draws the default as a shimmer line labelled with the status", () => {
    render(<ThinkingIndicator />);
    const line = screen.getByTestId("thinking-line");
    expect(line).toHaveAttribute("data-variant", "shimmer");
    expect(line).toHaveAttribute("data-mode", "thinking");
    expect(screen.getByRole("status")).toHaveAccessibleName("Thinking...");
    expect(screen.queryByTestId("thinking-dots")).not.toBeInTheDocument();
  });

  it("runs the line in compacting mode while compacting", () => {
    render(<ThinkingIndicator label="Compacting conversation…" />);
    expect(screen.getByTestId("thinking-line")).toHaveAttribute(
      "data-mode",
      "compacting"
    );
    expect(screen.getByRole("status")).toHaveAccessibleName(
      "Compacting conversation…"
    );
  });

  it.each([
    ["uplink", "uplink"],
    ["assembler", "assembler"],
  ] as const)("narrates the %s line with a sci-fi phrase", (style, variant) => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    render(<ThinkingIndicator style={style} />);
    expect(screen.getByTestId("thinking-line")).toHaveAttribute(
      "data-variant",
      variant
    );
    expect(FUTURISTIC_THINKING_PHRASES).toContain(
      screen.getByRole("status").textContent
    );
    random.mockRestore();
  });

  it("keeps an expressive thinking phrase stable across rerenders", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const { rerender } = render(<ThinkingIndicator style="uplink" />);
    const phrase = screen.getByRole("status").textContent;

    random.mockReturnValue(0.99);
    rerender(<ThinkingIndicator style="uplink" />);
    expect(screen.getByRole("status")).toHaveTextContent(phrase ?? "");
    random.mockRestore();
  });

  it("uses a stable themed phrase while compacting in an expressive style", () => {
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    const { rerender } = render(
      <ThinkingIndicator style="uplink" label="Compacting conversation…" />
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
      <ThinkingIndicator style="uplink" label="Compacting conversation…" />
    );
    expect(screen.getByRole("status")).toHaveTextContent(phrase ?? "");
    random.mockRestore();
  });

  it("preserves semantic activity labels for stopping and shimmer compaction", () => {
    render(
      <>
        <ThinkingIndicator style="uplink" label="Stopping..." />
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

  it("renders a compact shimmer without a visible status label", () => {
    render(<ThinkingIndicator compact />);

    const indicator = screen.getByTestId("thinking-indicator");
    expect(indicator).toHaveAttribute("data-compact", "true");
    expect(screen.getByRole("status")).toHaveAccessibleName("Thinking...");
    expect(screen.queryByText("Thinking...")).not.toBeInTheDocument();
    const line = screen.getByTestId("thinking-line");
    expect(line).toHaveStyle({ width: "40px", height: "10px" });
  });

  it("keeps compaction mode and accessibility in a compact expressive badge", () => {
    render(
      <ThinkingIndicator
        compact
        label="Compacting conversation…"
        style="uplink"
      />
    );

    const indicator = screen.getByTestId("thinking-indicator");
    expect(indicator).toHaveAttribute("data-compact", "true");
    expect(screen.getByTestId("thinking-line")).toHaveAttribute(
      "data-mode",
      "compacting"
    );
    expect(FUTURISTIC_COMPACTING_PHRASES).toContain(
      screen.getByRole("status").getAttribute("aria-label")
    );
  });

  it("caps the full-size line so it never reads as a full-width rule", () => {
    render(<ThinkingIndicator />);
    expect(screen.getByTestId("thinking-line")).toHaveStyle({
      width: "min(100%, 240px)",
    });
  });
});
