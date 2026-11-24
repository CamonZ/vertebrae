import { describe, expect, it } from "vitest";

/**
 * The focus halo lives in one block of styles/focus-halo.css. Components must not draw
 * their own focus outline, ring, border or shadow; they opt into variants
 * with aria-invalid or data-focus-halo instead.
 */
const components = import.meta.glob<string>(
  ["./**/*.tsx", "!./**/*.test.tsx"],
  { query: "?raw", import: "default", eager: true }
);
const stylesheets = import.meta.glob<string>("./**/*.css", {
  query: "?raw",
  import: "default",
  eager: true,
});

const FOCUS_UTILITY =
  /(?:^|[\s"'`])(?:focus|focus-visible|focus-within):(?:outline|ring|border|shadow)\S*/g;

/** `selector { body }` pairs for rules whose selector involves focus. */
function focusRules(css: string): { selector: string; body: string }[] {
  const rules: { selector: string; body: string }[] = [];
  const pattern = /([^{}]+)\{([^{}]*)\}/g;
  const source = css.replace(/\/\*[\s\S]*?\*\//g, "");
  for (const [, selector, body] of source.matchAll(pattern)) {
    // `:not(:focus-visible)` styles something else (e.g. selection).
    const positive = selector.replace(/:not\(:focus[\w-]*\)/g, "");
    if (/:focus(?:-visible|-within)?\b/.test(positive))
      rules.push({ selector: selector.trim(), body });
  }
  return rules;
}

const HALO_PROPERTIES =
  /(?:^|;|\s)(?:outline(?:-offset)?|box-shadow|border(?:-color)?)\s*:/;

describe("focus halo", () => {
  it("is not redrawn by Tailwind focus utilities in components", () => {
    const offenders = Object.entries(components).flatMap(([path, source]) =>
      [...source.matchAll(FOCUS_UTILITY)].map(
        (match) => `${path}: ${match[0].trim()}`
      )
    );
    expect(offenders).toEqual([]);
  });

  it("is only styled by the central block in styles/focus-halo.css", () => {
    const offenders = Object.entries(stylesheets).flatMap(([path, css]) =>
      focusRules(css)
        .filter(({ selector, body }) => {
          if (!HALO_PROPERTIES.test(body)) return false;
          // The central block and the forced-colors fallback.
          return !(
            path === "./styles/focus-halo.css" &&
            (selector.startsWith(":root") || selector.includes("forced-colors"))
          );
        })
        .map(({ selector }) => `${path}: ${selector}`)
    );
    expect(offenders).toEqual([]);
  });

  it("outranks state styles that also set box-shadow", () => {
    // Active chips, selected cards and hover glows must not hide focus.
    expect(stylesheets["./styles/focus-halo.css"]).toContain(
      "box-shadow: var(--focus-shadow) !important;"
    );
  });

  it("removes the browser focus ring from elements that opt out", () => {
    const rules = focusRules(stylesheets["./styles/focus-halo.css"]).filter(
      ({ selector }) =>
        selector.includes('[data-focus-halo="none"]:focus-visible')
    );
    expect(rules.map(({ body }) => body.trim())).toEqual([
      "outline: 1px solid transparent !important;",
    ]);
  });
});
