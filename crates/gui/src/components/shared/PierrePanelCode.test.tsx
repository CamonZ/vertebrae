import { render, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { getHighlighterType } from "@pierre/diffs";
import { CODE_HIGHLIGHTER } from "../../utils/codeAppearance";
import PierrePanelCode from "./PierrePanelCode";

// Separate processes exercise Pierre's one-backend-per-thread contract.
vi.mock("../../utils/codeAppearance", async (original) => ({
  ...(await original<typeof import("../../utils/codeAppearance")>()),
  CODE_HIGHLIGHTER: process.env.PANEL_TEST_BACKEND ?? "highlights",
}));
const sources = {
  json: '{\n  "value": 42,\n  "items": [true, null]\n}',
  liquid:
    '# Mixed Markdown\n{{- user.name | default: "guest" -}}\n{% if user %}hello{% endif %}',
  rhai: '// braces {;\nlet value = "};";\n/* multiline\n comment */\n#{value: value, items: [1, 2]}',
} as const;

describe("Pierre panel language policy", () => {
  it.each(["json", "liquid", "rhai"] as const)(
    "preserves and highlights %s",
    async (language) => {
      const { container } = render(
        <PierrePanelCode
          language={language}
          source={sources[language]}
          label={language}
        />
      );
      await waitFor(() => {
        const shadow = container.querySelector("diffs-container")?.shadowRoot;
        const lines = Array.from(shadow?.querySelectorAll("[data-line]") ?? []);
        expect(lines.map((line) => line.textContent).join("\n")).toBe(
          sources[language]
        );
        expect(shadow?.querySelector("[data-line] span[style]")).not.toBeNull();
        expect(shadow?.querySelector('[contenteditable="true"]')).toBeNull();
      });
      expect(getHighlighterType()).toBe(CODE_HIGHLIGHTER);
    }
  );
  it("updates a read-only viewer from new props", async () => {
    const { container, rerender } = render(
      <PierrePanelCode language="json" source="42" label="JSON" />
    );
    rerender(<PierrePanelCode language="json" source="84" label="JSON" />);
    await waitFor(() =>
      expect(
        container
          .querySelector("diffs-container")
          ?.shadowRoot?.querySelector("[data-line]")?.textContent
      ).toBe("84")
    );
  });
  it("infers artifact syntax and enables numbered wrapped viewers", async () => {
    const { container } = render(
      <PierrePanelCode
        language="text"
        filename="example.py"
        source="print(42)"
        label="Artifact source"
      />
    );
    await waitFor(() => {
      const shadow = container.querySelector("diffs-container")?.shadowRoot;
      expect(shadow?.querySelector("[data-line] span[style]")).not.toBeNull();
      expect(
        shadow?.querySelector("pre[data-disable-line-numbers]")
      ).toBeNull();
      expect(shadow?.querySelector('[data-overflow="wrap"]')).not.toBeNull();
    });
  });
});
