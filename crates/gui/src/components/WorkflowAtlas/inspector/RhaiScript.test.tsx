import { render, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { formatRhaiScript, RhaiScript } from "./RhaiScript";

describe("formatRhaiScript", () => {
  it("indents blocks and statements while keeping map literals readable", () => {
    expect(formatRhaiScript('if ready {let value=1; #{"value":value}}')).toBe(
      `if ready {\n  let value=1;\n  #{\n    "value":value\n  }\n}`
    );
  });

  it("leaves braces and semicolons inside strings and comments untouched", () => {
    expect(formatRhaiScript('let text="};"; // { ignored\ntext')).toBe(
      'let text="};";\n// { ignored\ntext'
    );
  });
});

describe("RhaiScript", () => {
  it("renders display-only formatting through Pierre", async () => {
    const { container } = render(
      <RhaiScript source={'let value = "};"; // braces {\n#{value: value}'} />
    );
    await waitFor(() => {
      const code = container
        .querySelector("diffs-container")
        ?.shadowRoot?.querySelector("[data-code]");
      expect(
        Array.from(code?.querySelectorAll("[data-line]") ?? [])
          .map((line) => line.textContent)
          .join("\n")
      ).toBe(
        formatRhaiScript('let value = "};"; // braces {\n#{value: value}')
      );
      expect(code?.querySelector("span[style]")).not.toBeNull();
      expect(code?.hasAttribute("contenteditable")).toBe(false);
    });
  });
});
