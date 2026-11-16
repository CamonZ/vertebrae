import { render, waitFor } from "@testing-library/react";
import { describe, it, expect } from "vitest";
import { LiquidHighlight } from "./LiquidHighlight";

describe("LiquidHighlight", () => {
  it("renders multiline Liquid through the real Pierre surface without evaluation", async () => {
    const source =
      '# Heading\n{{- user.name | default: "hello" -}}\n{% if user %}yes{% endif %}';
    const { container } = render(<LiquidHighlight source={source} />);
    await waitFor(() => {
      const code = container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector("[data-code]");
      expect(
        Array.from(code?.querySelectorAll("[data-line]") ?? [])
          .map((line) => line.textContent)
          .join("\n")
      ).toBe(source);
      expect(code?.querySelector("span[style]")).not.toBeNull();
      expect(code?.hasAttribute("contenteditable")).toBe(false);
    });
  });
});
