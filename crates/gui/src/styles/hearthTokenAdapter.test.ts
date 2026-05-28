import { describe, expect, it } from "vitest";
import { V2_TOKENS } from "./hearthTokenAdapter";

// @ts-expect-error Vitest runs this guard in Node; keep Node types out of app code.
import { readFileSync } from "node:fs";

const cwd = (
  globalThis as unknown as { process: { cwd(): string } }
).process.cwd();
const indexCss = readFileSync(`${cwd}/src/index.css`, "utf8");

const v2ComponentCss = [
  "../../docs/design/components-v2.css",
  "../../docs/design/lib/components-lib.css",
]
  .map((path) => readFileSync(`${cwd}/${path}`, "utf8"))
  .join("\n");

function customPropertiesUsedBy(css: string) {
  return Array.from(css.matchAll(/var\((--[\w-]+)/g), (match) => match[1])
    .sort()
    .filter((token, index, tokens) => token !== tokens[index - 1]);
}

function customPropertiesDefinedBy(css: string) {
  return new Set(
    Array.from(css.matchAll(/(--[\w-]+)\s*:/g), (match) => match[1])
  );
}

describe("Hearth v2 token adapter", () => {
  it("inventories the v2 prototype token vocabulary used by component CSS", () => {
    expect(customPropertiesUsedBy(v2ComponentCss)).toEqual(V2_TOKENS);
  });

  it("defines every v2 component token in the production GUI theme", () => {
    const definedTokens = customPropertiesDefinedBy(indexCss);

    expect(V2_TOKENS.filter((token) => !definedTokens.has(token))).toEqual([]);
  });

  it("keeps v2 short tokens as aliases over production Hearth tokens", () => {
    expect(indexCss).toContain("--bg: var(--color-bg);");
    expect(indexCss).toContain("--fg: var(--color-fg);");
    expect(indexCss).toContain("--accent: var(--color-accent);");
    expect(indexCss).toContain("--s-4: var(--spacing-4);");
    expect(indexCss).toContain("--r-md: var(--radius-md);");
    expect(indexCss).toContain("--serif: var(--font-serif);");
    expect(indexCss).not.toContain('@import "../../../docs/design');
  });
});
