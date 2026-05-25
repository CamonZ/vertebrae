import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Count } from "./Count";

describe("Count", () => {
  it("renders a non-zero count as a serif-italic copper accent numeral", () => {
    render(<Count value={34} />);
    const el = screen.getByText("34");
    expect(el.tagName).toBe("SPAN");
    expect(el.className).toContain("font-serif");
    expect(el.className).toContain("italic");
    expect(el.className).toContain("tabular-nums");
    expect(el.className).toContain("text-[var(--color-accent)]");
  });

  it("renders a zero count in the faint token, not the accent", () => {
    render(<Count value={0} />);
    const el = screen.getByText("0");
    expect(el.className).toContain("text-[var(--color-fg-faint)]");
    expect(el.className).not.toContain("text-[var(--color-accent)]");
  });

  it("uses semantic color tokens, never a hardcoded value", () => {
    render(<Count value={5} />);
    const el = screen.getByText("5");
    expect(el.className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("merges a caller className and forwards span attributes", () => {
    render(<Count value={7} className="ml-auto text-2xs" data-testid="c" />);
    const el = screen.getByTestId("c");
    expect(el).toHaveTextContent("7");
    expect(el.className).toContain("ml-auto");
    expect(el.className).toContain("text-2xs");
    expect(el.className).toContain("font-serif");
  });
});
