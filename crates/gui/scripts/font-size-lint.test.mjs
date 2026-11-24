import assert from "node:assert/strict";
import { test } from "node:test";
import stylelint from "stylelint";
import { findFontSizeViolations } from "./check-font-size-classes.mjs";

const config = {
  plugins: ["./scripts/stylelint-no-font-size-literals.mjs"],
  rules: { "vertebrae/no-font-size-literals": true },
};

async function cssWarnings(code) {
  const { results } = await stylelint.lint({
    code,
    config,
    configBasedir: new URL("..", import.meta.url).pathname,
  });
  return results[0].warnings.map((warning) => warning.text);
}

test("rejects literal font sizes in CSS", async () => {
  for (const declaration of [
    "font-size: 12px",
    "font-size: 0.8125rem",
    "font-size: calc(13px * var(--scale))",
    "font-size: var(--text-x, 11px)",
    "font-size: small",
    "font: 500 11px/16px var(--font-sans)",
    "font: italic 1rem var(--font-serif)",
    "--diffs-font-size: 13px",
  ]) {
    const warnings = await cssWarnings(`.a { ${declaration}; }`);
    assert.equal(warnings.length, 1, declaration);
    assert.match(warnings[0], /vertebrae\/no-font-size-literals/);
  }
});

test("allows type-scale tokens, relative sizes and line heights", async () => {
  for (const declaration of [
    "font-size: var(--text-meta)",
    "font-size: 0.85em",
    "font-size: 90%",
    "font-size: inherit",
    "font: 500 var(--text-meta)/16px var(--font-sans)",
    "font: inherit",
    "line-height: 16px",
    "--diffs-font-size: var(--text-code)",
  ]) {
    assert.deepEqual(await cssWarnings(`.a { ${declaration}; }`), [], declaration);
  }
});

test("rejects arbitrary and retired size classes and literal inline sizes", () => {
  const source = [
    '<p className="text-[13px] text-fg" />',
    '<p className="text-[length:12px]" />',
    '<p className="text-xs" />',
    '<p className="sm:text-sm" />',
    "<p style={{ fontSize: 12 }} />",
    '<text fontSize="14" />',
    'const style = { "--diffs-font-size": "13px" };',
  ].join("\n");
  const lines = findFontSizeViolations(source, "src/x.tsx").map((v) => v.line);
  assert.deepEqual(lines, [1, 2, 3, 4, 5, 6, 7]);
});

test("allows scale utilities, colors, and SVG user units where documented", () => {
  const source = [
    '<p className="text-meta text-secondary text-content text-code text-lg" />',
    '<p className="text-[var(--color-fg)] text-fg-mute" />',
    "<p style={{ fontSize: size }} />",
  ].join("\n");
  assert.deepEqual(findFontSizeViolations(source, "src/x.tsx"), []);
  assert.deepEqual(
    findFontSizeViolations(
      '<text fontSize="14" />',
      "src/components/Artifacts/StatechartViewer.tsx"
    ),
    []
  );
});
