import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const stylesheet = readFileSync(
  fileURLToPath(new URL("../src/index.css", import.meta.url)),
  "utf8"
);

function ruleFor(selector) {
  const escapedSelector = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = stylesheet.match(
    new RegExp(`(?:^|\\n)${escapedSelector}\\s*\\{([^}]*)\\}`, "m")
  );

  assert.ok(match, `Missing CSS rule for ${selector}`);
  return match[1];
}

test("dark selection uses the muted copper accent with readable text", () => {
  const darkSelection = ruleFor("::selection");

  assert.match(
    darkSelection,
    /background-color:\s*var\(--color-accent-mute\);/
  );
  assert.match(darkSelection, /color:\s*var\(--color-fg\);/);
});

test("light selection uses the muted copper accent with readable foreground text", () => {
  const lightSelection = ruleFor("html.light ::selection");

  assert.match(
    lightSelection,
    /background-color:\s*var\(--color-accent-mute\);/
  );
  assert.match(lightSelection, /color:\s*var\(--color-fg\);/);
});

test("light chat panels retain a frosted surface treatment", () => {
  const lightPanel = ruleFor(".light .hc-panel");

  assert.match(lightPanel, /background:\s*linear-gradient/);
  assert.match(lightPanel, /,\s*transparent\)/);
  assert.match(lightPanel, /var\(--bg-3\) 24%/);
  assert.match(lightPanel, /backdrop-filter:\s*blur\(30px\)/);
  assert.match(
    lightPanel,
    /border-color:\s*color-mix\(in oklch, var\(--fg\) 18%, transparent\);/
  );
});
