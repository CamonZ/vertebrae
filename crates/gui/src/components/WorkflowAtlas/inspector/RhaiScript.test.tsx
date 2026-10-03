import { render, screen } from "@testing-library/react";
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
  it("registers Rhai highlighting and renders the formatted display source", () => {
    render(<RhaiScript source="let count=1;" />);

    const code = screen
      .getByTestId("rhai-script-highlighted")
      .querySelector("code");
    expect(code).toHaveClass("language-rhai");
    const keyword = [...(code?.querySelectorAll(".token") ?? [])].find(
      (token) => token.textContent === "let"
    );
    expect(keyword?.getAttribute("style")).toMatch(/color:/);
    expect(code).toHaveTextContent("let count=1;");
  });
});
