import { describe, expect, it } from "vitest";
import indexCss from "../../index.css?raw";
import threadCss from "./thread.css?raw";

// thread.css is unlayered, so any of its rules beats the Tailwind utilities
// MarkdownContent puts on inline code. Rules that reach inline code must
// therefore read the Appearance tokens themselves.
const rules = [
  ...threadCss
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]+)\{([^}]*)\}/g),
].map(([, selector, body]) => ({
  selectors: selector.split(",").map((part) => part.trim()),
  body,
}));

const declaration = (body: string, property: string) =>
  body.match(new RegExp(`(?:^|;)\\s*${property}\\s*:\\s*([^;]+)`))?.[1].trim();

// Fenced blocks live in `.group`; their reset is not inline code styling.
const inlineCodeRules = rules.filter(({ selectors }) =>
  selectors.some((s) => /(^|\s)code$/.test(s) && !s.includes(".group"))
);

describe("thread.css inline code", () => {
  it("styles agent prose and user message code", () => {
    const selectors = inlineCodeRules.flatMap((rule) => rule.selectors);
    expect(selectors).toContain(".evprose code");
    expect(selectors).toContain(".evrow--user .ev-text .markdown-content code");
  });

  it.each(inlineCodeRules.map((rule) => [rule.selectors.join(", "), rule]))(
    "%s reads the configured inline code colors",
    (_, rule) => {
      expect(declaration(rule.body, "color")).toBe("var(--inline-code-fg)");
      expect(declaration(rule.body, "background")).toBe(
        "var(--inline-code-bg)"
      );
    }
  );

  it("never colors code or links with the accent", () => {
    const offending = rules.filter(
      ({ selectors, body }) =>
        selectors.some((s) => /(^|\s)(code|a)$/.test(s)) &&
        /var\(--accent/.test(body)
    );
    expect(offending.map((rule) => rule.selectors.join(", "))).toEqual([]);
  });
});

describe("index.css link token", () => {
  const rootDeclaration = (property: string) =>
    [
      ...indexCss
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .matchAll(/(?:^|})\s*:root\s*\{([^}]*)\}/g),
    ]
      .map(([, body]) => declaration(body, property))
      .find(Boolean);

  it("colors links with the configured inline code text color", () => {
    expect(rootDeclaration("--link-fg")).toBe("var(--inline-code-fg)");
  });
});
