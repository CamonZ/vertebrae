import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { EmWord } from "./EmWord";

describe("EmWord", () => {
  it("renders an <em> element with the heading-accent cursive styling", () => {
    render(<EmWord>firelight</EmWord>);
    const el = screen.getByText("firelight");
    expect(el.tagName).toBe("EM");
    // Cursive role A: Newsreader serif italic in copper accent.
    expect(el.className).toContain("font-serif");
    expect(el.className).toContain("italic");
    expect(el.className).toContain("text-[var(--color-accent)]");
  });

  it("uses the semantic accent token for color, never a hardcoded value", () => {
    render(<EmWord>JWT</EmWord>);
    const el = screen.getByText("JWT");
    // Must route through the semantic copper token so both themes stay correct.
    expect(el.className).toContain("var(--color-accent)");
    expect(el.className).not.toMatch(/#[0-9a-fA-F]{3,8}/);
  });

  it("merges a caller className without dropping the cursive defaults", () => {
    render(<EmWord className="ml-1">Board</EmWord>);
    const el = screen.getByText("Board");
    expect(el.className).toContain("ml-1");
    expect(el.className).toContain("font-serif");
    expect(el.className).toContain("italic");
  });
});
