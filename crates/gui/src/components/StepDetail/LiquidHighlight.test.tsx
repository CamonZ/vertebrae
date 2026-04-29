import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { LiquidHighlight, tokenizeLiquid } from "./LiquidHighlight";

describe("tokenizeLiquid", () => {
  it("emits a single text token for plain prose", () => {
    const tokens = tokenizeLiquid("Just some plain text.");
    expect(tokens).toEqual([{ kind: "text", value: "Just some plain text." }]);
  });

  it("classifies an output tag with identifier and delimiters", () => {
    const tokens = tokenizeLiquid("Hello {{ user.name }}!");
    expect(tokens).toEqual([
      { kind: "text", value: "Hello " },
      { kind: "delimiter", value: "{{" },
      { kind: "text", value: " " },
      { kind: "identifier", value: "user" },
      { kind: "operator", value: "." },
      { kind: "identifier", value: "name" },
      { kind: "text", value: " " },
      { kind: "delimiter", value: "}}" },
      { kind: "text", value: "!" },
    ]);
  });

  it("classifies control tag names as keywords", () => {
    const tokens = tokenizeLiquid("{% if user.admin %}yes{% endif %}");
    const keywords = tokens.filter((t) => t.kind === "keyword").map((t) => t.value);
    expect(keywords).toEqual(["if", "endif"]);
    const delimiters = tokens.filter((t) => t.kind === "delimiter").map((t) => t.value);
    expect(delimiters).toEqual(["{%", "%}", "{%", "%}"]);
  });

  it("classifies filters, strings and numbers", () => {
    const tokens = tokenizeLiquid('{{ count | default: 0 | append: "x" }}');
    const filters = tokens.filter((t) => t.kind === "filter").map((t) => t.value);
    const strings = tokens.filter((t) => t.kind === "string").map((t) => t.value);
    const numbers = tokens.filter((t) => t.kind === "number").map((t) => t.value);
    const idents = tokens.filter((t) => t.kind === "identifier").map((t) => t.value);
    expect(filters).toEqual(["|", "|"]);
    expect(strings).toEqual(['"x"']);
    expect(numbers).toEqual(["0"]);
    expect(idents).toEqual(["count", "default", "append"]);
  });

  it("recognises reserved literals (true/false/nil) as keywords inside output tags", () => {
    const tokens = tokenizeLiquid("{{ flag | default: true }}");
    const keywords = tokens.filter((t) => t.kind === "keyword").map((t) => t.value);
    expect(keywords).toContain("true");
    // 'flag' and 'default' are NOT reserved words.
    expect(keywords).not.toContain("flag");
    expect(keywords).not.toContain("default");
  });

  it("handles whitespace-control delimiters {{- ... -}}", () => {
    const tokens = tokenizeLiquid("a {{- x -}} b");
    const delims = tokens.filter((t) => t.kind === "delimiter").map((t) => t.value);
    expect(delims).toEqual(["{{-", "-}}"]);
  });
});

describe("LiquidHighlight", () => {
  it("renders prose-only input as plain text", () => {
    render(<LiquidHighlight source="just prose" />);
    const node = screen.getByTestId("liquid-highlight");
    expect(node.textContent).toBe("just prose");
    // No syntax-coloured token spans for plain text.
    expect(node.querySelectorAll("[data-token]").length).toBe(0);
  });

  it("renders distinct token spans for output tags, control tags, and filters", () => {
    const src = 'Hello {{ name | upcase }}, {% if admin %}admin{% endif %}!';
    render(<LiquidHighlight source={src} />);
    const node = screen.getByTestId("liquid-highlight");

    // Full text round-trips.
    expect(node.textContent).toBe(src);

    // Delimiters all marked as such.
    const delimiters = Array.from(node.querySelectorAll('[data-token="delimiter"]')).map(
      (el) => el.textContent
    );
    expect(delimiters).toEqual(["{{", "}}", "{%", "%}", "{%", "%}"]);

    // Filter pipe is highlighted.
    const filters = Array.from(node.querySelectorAll('[data-token="filter"]')).map(
      (el) => el.textContent
    );
    expect(filters).toEqual(["|"]);

    // 'if' and 'endif' are keywords; 'name', 'upcase', 'admin' are identifiers.
    const keywords = Array.from(node.querySelectorAll('[data-token="keyword"]')).map(
      (el) => el.textContent
    );
    expect(keywords).toEqual(["if", "endif"]);

    const identifiers = Array.from(node.querySelectorAll('[data-token="identifier"]')).map(
      (el) => el.textContent
    );
    expect(identifiers).toEqual(["name", "upcase", "admin"]);
  });

  it("preserves whitespace and newlines for multiline prompts", () => {
    const src = "Line 1\n  {{ value }}\nLine 3";
    render(<LiquidHighlight source={src} />);
    const node = screen.getByTestId("liquid-highlight");
    expect(node.textContent).toBe(src);
    // whitespace-pre-wrap class so the rendered string preserves the newlines visually.
    expect(node.className).toContain("whitespace-pre-wrap");
    expect(node.className).toContain("font-mono");
  });
});
